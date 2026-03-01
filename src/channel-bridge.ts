/**
 * channel-bridge.ts
 *
 * Bridges Pi session events to OpenClaw messaging channels.
 *
 * Pi SDK types are not available at compile time, so the `session` parameter
 * is typed as `any` throughout. All channel interactions go through the
 * strongly-typed {@link OpenClawChannel} interface from ./types.ts.
 */

import type {
  OpenClawChannel,
  RunMessage,
  RunMessageType,
  SessionEventHandlers,
} from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Options that control which Pi session events produce channel notifications.
 */
export interface BridgeOptions {
  /**
   * When true, a short notification is sent to the channel each time a tool
   * execution begins. Defaults to false to keep channels quiet during heavy
   * tool use.
   */
  notifyOnToolStart?: boolean;
}

/**
 * Builds a {@link SessionEventHandlers} object that wires Pi session events
 * into a string accumulator and flushes to the channel on agent end.
 *
 * Separated from {@link bridgeSessionToChannel} so the handler logic can be
 * unit-tested without requiring a live session object.
 *
 * @internal
 */
function buildSessionHandlers(
  channel: OpenClawChannel,
  options: BridgeOptions,
): SessionEventHandlers {
  let buffer = '';

  return {
    onAgentStart() {
      buffer = '';
    },

    onTextDelta(delta: string) {
      buffer += delta;
    },

    onToolStart(toolName: string) {
      if (options.notifyOnToolStart === true) {
        // Fire-and-forget; channel errors are non-fatal for the session.
        channel
          .sendMessage(`[tool] ${toolName} started`)
          .catch((err: unknown) => {
            console.error(
              '[channel-bridge] sendMessage failed on tool start',
              err,
            );
          });
      }
    },

    onToolEnd(_toolName: string, _result: string) {
      // No channel notification by default; the onAgentEnd flush covers it.
    },

    onAgentEnd(fullText: string) {
      // Use fullText when available (provided by session), otherwise fall back
      // to whatever was accumulated in the buffer.
      const text = fullText.length > 0 ? fullText : buffer;
      buffer = '';

      if (text.length === 0) {
        return;
      }

      channel.sendMessage(text).catch((err: unknown) => {
        console.error('[channel-bridge] sendMessage failed on agent end', err);
      });
    },

    onError(error: Error) {
      console.error('[channel-bridge] session error', error);
    },
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Subscribes to Pi session events and forwards them to an OpenClaw channel.
 *
 * Text deltas are buffered in memory. When the agent finishes a turn
 * (`agent_end`), the accumulated text is sent as a single channel message.
 * This avoids flooding messaging apps with dozens of partial-text messages
 * during streaming.
 *
 * If {@link BridgeOptions.notifyOnToolStart} is `true`, a brief notification
 * is also sent whenever a tool execution begins.
 *
 * @param session - A Pi SDK session object. Typed as `any` because the Pi SDK
 *   is a peer dependency whose types are not available at build time.
 * @param channel - The OpenClaw channel to send messages to.
 * @param options - Optional configuration for bridge behaviour.
 * @returns An unsubscribe function. Call it to stop forwarding events.
 *
 * @example
 * ```ts
 * const unsubscribe = bridgeSessionToChannel(session, telegramChannel, {
 *   notifyOnToolStart: true,
 * });
 * // Later, when the session is no longer needed:
 * unsubscribe();
 * ```
 */
export function bridgeSessionToChannel(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  channel: OpenClawChannel,
  options: BridgeOptions = {},
): () => void {
  const handlers = buildSessionHandlers(channel, options);

  // The Pi SDK exposes session events via session.subscribe(handlers).
  // The exact shape of the subscription object is unknown at compile time,
  // so we capture the return value as `any` and call `.unsubscribe()` if it
  // exists, or fall back to a no-op.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let subscription: any;

  try {
    subscription = session.subscribe({
      agent_start: handlers.onAgentStart,
      text_delta: handlers.onTextDelta,
      tool_execution_start: handlers.onToolStart,
      tool_execution_end: handlers.onToolEnd,
      agent_end: handlers.onAgentEnd,
      error: handlers.onError,
    });
  } catch (err) {
    console.error('[channel-bridge] session.subscribe() failed', err);
    return () => {
      /* no-op: subscription never started */
    };
  }

  return () => {
    try {
      if (
        subscription != null &&
        typeof subscription.unsubscribe === 'function'
      ) {
        subscription.unsubscribe();
      }
    } catch (err) {
      console.error('[channel-bridge] unsubscribe failed', err);
    }
  };
}

/**
 * Listens for incoming messages on an OpenClaw channel and routes each one
 * to the Pi session as a prompt.
 *
 * If the channel delivers images alongside the text message, and if the Pi
 * session exposes a method for multi-modal prompts, the image URLs are
 * forwarded as well. Otherwise, they are appended as plain-text references
 * so the agent can still reason about them.
 *
 * @param channel - The OpenClaw channel to listen on.
 * @param session - A Pi SDK session object. Typed as `any` because the Pi SDK
 *   is a peer dependency whose types are not available at build time.
 *
 * @example
 * ```ts
 * bridgeChannelToSession(telegramChannel, session);
 * ```
 */
export function bridgeChannelToSession(
  channel: OpenClawChannel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
): void {
  channel.onMessage((text: string, images?: string[]) => {
    let promptText = text;

    const hasImages = images != null && images.length > 0;

    if (hasImages) {
      // If the session understands multi-modal input, prefer that path.
      if (typeof session.promptWithImages === 'function') {
        session.promptWithImages(promptText, images).catch((err: unknown) => {
          console.error(
            '[channel-bridge] session.promptWithImages() failed',
            err,
          );
        });
        return;
      }

      // Fallback: append image URLs as text so the agent is at least aware.
      const imageRefs = images
        .map((url, i) => `[image ${i + 1}]: ${url}`)
        .join('\n');
      promptText = `${promptText}\n\n${imageRefs}`;
    }

    session.prompt(promptText).catch((err: unknown) => {
      console.error('[channel-bridge] session.prompt() failed', err);
    });
  });
}

// ---------------------------------------------------------------------------
// RunMessage formatting (for simple-harness integration)
// ---------------------------------------------------------------------------

/** All valid customType values emitted by simple-harness. */
const VALID_RUN_MESSAGE_TYPES = new Set<RunMessageType>([
  'run-merge',
  'run-dispatch',
  'run-status',
  'run-complete',
  'run-error',
  'run-stopped',
  'run-cleanup',
]);

/** Short prefix labels for each run message type. */
const RUN_MESSAGE_PREFIXES: Record<RunMessageType, string> = {
  'run-merge': '[merge]',
  'run-dispatch': '[dispatch]',
  'run-status': '[status]',
  'run-complete': '[complete]',
  'run-error': '[error]',
  'run-stopped': '[stopped]',
  'run-cleanup': '[cleanup]',
};

/**
 * Type guard that narrows an unknown value to a {@link RunMessage}.
 *
 * Validates that the value is a non-null object with a valid `customType`
 * string from the known set, a string `content`, and a boolean `display`.
 */
export function isRunMessage(message: unknown): message is RunMessage {
  if (typeof message !== 'object' || message === null) return false;

  const obj = message as Record<string, unknown>;
  return (
    typeof obj.customType === 'string' &&
    VALID_RUN_MESSAGE_TYPES.has(obj.customType as RunMessageType) &&
    typeof obj.content === 'string' &&
    typeof obj.display === 'boolean'
  );
}

/**
 * Formats a {@link RunMessage} into a human-readable string suitable for
 * mobile messaging apps.
 *
 * Each message type receives a short prefix bracket (e.g. `[merge]`,
 * `[error]`) followed by the content. This keeps the output scannable
 * on small screens.
 *
 * @param message - A validated RunMessage from simple-harness.
 * @returns A plain-text string ready to send to a channel.
 */
export function formatRunMessageForChannel(message: RunMessage): string {
  const prefix = RUN_MESSAGE_PREFIXES[message.customType];
  return `${prefix} ${message.content}`;
}

/**
 * Formats a {@link RunMessage} and sends it to an OpenClaw channel.
 *
 * Channel errors are caught and logged — they never propagate to the caller.
 *
 * @param message - A validated RunMessage from simple-harness.
 * @param channel - The OpenClaw channel to send the formatted message to.
 */
export async function bridgeRunMessageToChannel(
  message: RunMessage,
  channel: OpenClawChannel,
): Promise<void> {
  const text = formatRunMessageForChannel(message);
  try {
    await channel.sendMessage(text);
  } catch (err) {
    console.error(
      '[channel-bridge] sendMessage failed for RunMessage',
      message.customType,
      err,
    );
  }
}
