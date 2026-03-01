/**
 * Pi Session Embedder — core integration point where OpenClaw launches Pi
 * with harness extensions.
 *
 * @mariozechner/pi-coding-agent is declared as a peer dependency and may not
 * be installed at dev time, so all imports from that package are handled via
 * dynamic import at runtime. Compile-time types are imported with `import type`
 * so they are erased and never emitted into JavaScript output.
 *
 * Public surface uses only types defined in ./types.ts. Pi SDK objects are
 * typed as `any` at the boundaries where the actual classes are not available
 * at compile time.
 */

import type { HarnessAgentConfig, SessionEventHandlers } from './types.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Lazily-resolved reference to the pi-coding-agent module. Cached after the
 * first successful dynamic import so subsequent calls pay no import cost.
 */
let _piModule: Record<string, unknown> | null = null;

/**
 * Dynamically imports @mariozechner/pi-coding-agent and caches the result.
 *
 * Using a dynamic import lets this module compile cleanly even when the peer
 * dependency is not installed during development. TypeScript erases the
 * `import type` references, so the only runtime coupling is this one call.
 *
 * @throws {Error} When the peer dependency is not installed at runtime.
 */
async function getPiModule(): Promise<Record<string, unknown>> {
  if (_piModule !== null) {
    return _piModule;
  }

  try {
    // Dynamic import — TypeScript emits this verbatim; no compile-time types
    // are consumed from the result.
    _piModule = (await import('@mariozechner/pi-coding-agent')) as Record<
      string,
      unknown
    >;
    return _piModule;
  } catch (cause) {
    throw new Error(
      'Peer dependency @mariozechner/pi-coding-agent is not installed. ' +
        'Install it alongside openclaw-pi-harness before creating a harness session.',
      { cause },
    );
  }
}

/**
 * Extracts the text content from the last assistant message in a Pi session.
 *
 * Pi's `AgentMessage` union can include both user and assistant messages.
 * This helper walks backwards through the recorded messages looking for the
 * first assistant message whose content contains at least one text block.
 *
 * @param session - A live `AgentSession` (typed as `any`).
 * @returns The concatenated text content, or an empty string when no text was
 *   produced.
 */
function extractLastAssistantText(session: any): string {
  // AgentSession exposes a convenience getter for exactly this purpose.
  const quick: string | undefined = session.getLastAssistantText?.();
  if (typeof quick === 'string') {
    return quick;
  }

  // Fallback: walk the message array manually for forward-compatibility.
  const messages: any[] = session.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant') continue;

    const parts: any[] = Array.isArray(msg.content) ? msg.content : [];
    const text = parts
      .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
      .map((p: any) => p.text as string)
      .join('');

    if (text.length > 0) {
      return text;
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Opaque wrapper returned by {@link createHarnessSession}.
 *
 * Callers pass this value to {@link runHarnessAgent} and
 * {@link subscribeToSession} without needing to know the underlying Pi types.
 */
export interface HarnessSession {
  /** The raw `AgentSession` from the Pi SDK (typed as `any`). */
  readonly piSession: any;
  /** The workspace path this session was created for. */
  readonly workspace: string;
}

/**
 * Creates an embedded Pi agent session with harness extensions loaded.
 *
 * Follows the OpenClaw Pi integration pattern:
 * 1. Construct a `DefaultResourceLoader` pointing at the workspace and each
 *    supplied extension path.
 * 2. Call `loader.reload()` to trigger extension discovery.
 * 3. Call `createAgentSession()` with the loader and an in-memory
 *    `SessionManager` so no session files are written to disk.
 *
 * @param config - Harness agent configuration including `workspace` (the
 *   working directory for tool path resolution and resource discovery) and
 *   `extensions` (absolute paths to Pi extension `.ts` or `.js` files).
 * @returns A {@link HarnessSession} wrapping the live Pi `AgentSession`.
 *
 * @example
 * ```ts
 * const session = await createHarnessSession({
 *   workspace: '/home/user/project',
 *   extensions: ['/home/user/.pi/extensions/harness.ts'],
 *   heartbeat: { enabled: true, intervalMs: 60_000 },
 *   harness: { maxWorkers: 3, staggerMs: 5000, tmuxServer: 'pi-harness' },
 * });
 * ```
 */
export async function createHarnessSession(
  config: HarnessAgentConfig,
): Promise<HarnessSession> {
  const pi = await getPiModule();

  // Retrieve the constructors / functions we need, asserting the shapes we
  // know from the SDK declaration files (they are `any` at runtime because
  // we skipped a compile-time import).
  const DefaultResourceLoader = pi['DefaultResourceLoader'] as new (
    opts: any,
  ) => any;
  const createAgentSession = pi['createAgentSession'] as (
    opts?: any,
  ) => Promise<any>;
  const SessionManager = pi['SessionManager'] as {
    inMemory: () => any;
  };

  // Build a resource loader scoped to the workspace path, with each harness
  // extension path registered via `additionalExtensionPaths`.
  const loader = new DefaultResourceLoader({
    cwd: config.workspace,
    additionalExtensionPaths: config.extensions,
  });

  // Trigger extension discovery before constructing the session so that all
  // extensions are registered in the loader's result before it is handed off.
  await loader.reload();

  // Create the session. We use an in-memory SessionManager to avoid writing
  // session files — the harness manages its own persistence layer.
  const { session } = await createAgentSession({
    cwd: config.workspace,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
  });

  return { piSession: session, workspace: config.workspace };
}

/**
 * Runs the agent with a prompt and optional lifecycle callbacks.
 *
 * Subscribes to the session's event stream to relay streaming text deltas,
 * tool lifecycle events, and agent start/end notifications to the caller via
 * {@link SessionEventHandlers}. The subscription is torn down once the agent
 * finishes processing the prompt.
 *
 * @param session - A {@link HarnessSession} previously created by
 *   {@link createHarnessSession}.
 * @param prompt - The user prompt text to send to the agent.
 * @param callbacks - Optional {@link SessionEventHandlers} that receive
 *   fine-grained events during the agent run. When omitted the function still
 *   resolves with the final response text but emits no callbacks.
 * @returns The full response text produced by the agent for this prompt.
 *
 * @example
 * ```ts
 * const result = await runHarnessAgent(session, 'List all TypeScript files.', {
 *   onTextDelta: (delta) => process.stdout.write(delta),
 *   onToolStart: (name) => console.log(`Tool: ${name}`),
 * });
 * console.log('Done:', result);
 * ```
 */
export async function runHarnessAgent(
  session: HarnessSession,
  prompt: string,
  callbacks?: SessionEventHandlers,
): Promise<string> {
  // Relay events to the caller's handlers while the agent is running.
  const unsubscribe = subscribeToSession(session, callbacks ?? {});

  try {
    await session.piSession.prompt(prompt);
  } finally {
    // Always remove the listener, even if prompt() throws.
    unsubscribe();
  }

  return extractLastAssistantText(session.piSession);
}

/**
 * Subscribes to Pi session events and relays them to the provided handler
 * functions.
 *
 * Maps the Pi SDK's `AgentSessionEvent` discriminated union to the simpler
 * {@link SessionEventHandlers} interface expected by OpenClaw consumers.
 * Unknown event types are silently ignored for forward-compatibility.
 *
 * @param session - A {@link HarnessSession} whose underlying Pi session will
 *   be observed.
 * @param handlers - An object whose optional methods are called when the
 *   corresponding Pi session events are emitted.
 * @returns A zero-argument unsubscribe function. Call it to stop receiving
 *   events (e.g. after the agent turn completes or when the harness shuts
 *   down).
 *
 * @example
 * ```ts
 * const stop = subscribeToSession(session, {
 *   onAgentStart: () => console.log('Agent started'),
 *   onTextDelta: (d) => process.stdout.write(d),
 *   onAgentEnd: (text) => console.log('\nFinal:', text),
 *   onError: (err) => console.error('Agent error:', err),
 * });
 *
 * await session.piSession.prompt('Hello');
 * stop();
 * ```
 */
export function subscribeToSession(
  session: HarnessSession,
  handlers: SessionEventHandlers,
): () => void {
  const piSession: any = session.piSession;

  /**
   * Listener passed to `AgentSession.subscribe()`.
   *
   * The Pi SDK guarantees that each `AgentSessionEvent` has a `type` string
   * discriminant. We switch on those discriminants and map them to the
   * narrower OpenClaw handler surface.
   */
  const listener = (event: any): void => {
    try {
      switch (event.type as string) {
        // -----------------------------------------------------------------
        // Agent lifecycle
        // -----------------------------------------------------------------
        case 'agent_start':
          handlers.onAgentStart?.();
          break;

        case 'agent_end': {
          // Resolve full text from the session now that the run is complete.
          const fullText = extractLastAssistantText(piSession);
          handlers.onAgentEnd?.(fullText);
          break;
        }

        // -----------------------------------------------------------------
        // Streaming text output
        // -----------------------------------------------------------------
        case 'message_update': {
          const assistantEvent: any = event.assistantMessageEvent;
          if (assistantEvent?.type === 'text_delta') {
            const delta: string =
              typeof assistantEvent.delta === 'string'
                ? assistantEvent.delta
                : '';
            if (delta.length > 0) {
              handlers.onTextDelta?.(delta);
            }
          }
          break;
        }

        // -----------------------------------------------------------------
        // Tool execution
        // -----------------------------------------------------------------
        case 'tool_execution_start': {
          const toolName: string =
            typeof event.toolName === 'string' ? event.toolName : '(unknown)';
          handlers.onToolStart?.(toolName);
          break;
        }

        case 'tool_execution_end': {
          const toolName: string =
            typeof event.toolName === 'string' ? event.toolName : '(unknown)';

          // Extract a text representation of the tool result. The Pi SDK
          // `result` field shape varies by tool; we serialise conservatively.
          let resultText = '';
          if (event.result !== undefined && event.result !== null) {
            const resultContent: any[] = Array.isArray(event.result?.content)
              ? (event.result.content as any[])
              : [];

            resultText = resultContent
              .filter(
                (block: any) =>
                  block?.type === 'text' && typeof block.text === 'string',
              )
              .map((block: any) => block.text as string)
              .join('\n');

            // Fall back to JSON when there are no text blocks.
            if (resultText.length === 0) {
              try {
                resultText = JSON.stringify(event.result);
              } catch {
                resultText = String(event.result);
              }
            }
          }

          handlers.onToolEnd?.(toolName, resultText);
          break;
        }

        // -----------------------------------------------------------------
        // All other events (turn_start, turn_end, message_start,
        // message_end, tool_execution_update, auto_compaction_*, etc.) are
        // intentionally not forwarded — they are Pi internals that OpenClaw
        // harness consumers do not need.
        // -----------------------------------------------------------------
        default:
          break;
      }
    } catch (handlerError) {
      // Route errors thrown inside user-supplied handlers through onError so
      // the caller has a chance to log or recover without crashing the
      // listener loop.
      if (handlerError instanceof Error) {
        handlers.onError?.(handlerError);
      } else {
        handlers.onError?.(
          new Error(
            `Unexpected non-Error thrown in session event handler: ${String(handlerError)}`,
          ),
        );
      }
    }
  };

  // `AgentSession.subscribe()` returns an unsubscribe function.
  const unsubscribe: () => void = piSession.subscribe(listener);
  return unsubscribe;
}

/**
 * Disposes a harness session and releases all resources held by the underlying
 * Pi `AgentSession`.
 *
 * After calling this function the session must not be passed to
 * {@link runHarnessAgent} or {@link subscribeToSession} again.
 *
 * @param session - The session to dispose.
 */
export function disposeHarnessSession(session: HarnessSession): void {
  session.piSession.dispose?.();
}

/**
 * Type guard that narrows an unknown value to a {@link HarnessSession}.
 *
 * @param value - Value to test.
 */
export function isHarnessSession(value: unknown): value is HarnessSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    'piSession' in value &&
    'workspace' in value
  );
}

// ---------------------------------------------------------------------------
// Re-export callback types for consumers that import from this module only
// ---------------------------------------------------------------------------
export type { HarnessAgentConfig, SessionEventHandlers };
