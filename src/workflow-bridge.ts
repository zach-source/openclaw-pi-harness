/**
 * workflow-bridge.ts
 *
 * Wraps the command router with the OpenClaw channel bridge so that workflow
 * commands sent from messaging channels are expanded into full prompts before
 * being forwarded to the Pi session.
 *
 * This is a drop-in alternative to {@link bridgeChannelToSession} from
 * `channel-bridge.ts`. The original function is NOT modified — callers can
 * choose which bridge to use.
 */

import type { OpenClawChannel } from "./types.js";
import {
  expandPrompt,
  loadAgentOsConfig,
  loadWorkflow,
  parseMessage,
  processConditionals,
  unknownCommandMessage,
  WORKFLOW_COMMANDS,
} from "./command-router.js";
import type { CommandRouterOptions } from "./command-router.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowBridgeOptions extends CommandRouterOptions {
  /**
   * When true (the default), sends a help message to the channel if the user
   * sends a `/hyphenated-command` that isn't a known workflow or passthrough.
   */
  suggestOnUnknownCommand?: boolean;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Listens for incoming messages on an OpenClaw channel and routes each one
 * to the Pi session — expanding workflow commands into full prompts.
 *
 * For non-workflow messages (including `/run`, plain text, etc.) the behaviour
 * is identical to `bridgeChannelToSession` from `channel-bridge.ts`.
 *
 * @param channel - The OpenClaw channel to listen on.
 * @param session - A Pi SDK session object (`any` — peer dependency).
 * @param options - Workflow directories, config path, and behaviour flags.
 */
export function bridgeChannelToSessionWithWorkflows(
  channel: OpenClawChannel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  options: WorkflowBridgeOptions,
): void {
  const { workflowsDir, configPath, suggestOnUnknownCommand = true } = options;

  channel.onMessage((text: string, images?: string[]) => {
    const parsed = parseMessage(text);

    if (parsed.kind === "command") {
      handleWorkflowCommand(
        parsed.command,
        parsed.args,
        session,
        channel,
        workflowsDir,
        configPath,
      );
      return;
    }

    // Check for unknown hyphenated slash-commands that might be typos.
    if (suggestOnUnknownCommand) {
      const trimmed = text.trim();
      if (trimmed.startsWith("/") && /^\/[a-z]+-[a-z]/.test(trimmed)) {
        const spaceIdx = trimmed.indexOf(" ");
        const rawCmd =
          spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
        if (!WORKFLOW_COMMANDS.has(rawCmd as any)) {
          channel
            .sendMessage(unknownCommandMessage(rawCmd))
            .catch((err: unknown) => {
              console.error(
                "[workflow-bridge] sendMessage failed for unknown command hint",
                err,
              );
            });
          return;
        }
      }
    }

    // Passthrough: replicate bridgeChannelToSession behaviour.
    const hasImages = images != null && images.length > 0;

    if (hasImages) {
      if (typeof session.promptWithImages === "function") {
        session.promptWithImages(text, images).catch((err: unknown) => {
          console.error(
            "[workflow-bridge] session.promptWithImages() failed",
            err,
          );
        });
        return;
      }

      const imageRefs = images
        .map((url: string, i: number) => `[image ${i + 1}]: ${url}`)
        .join("\n");
      const promptText = `${text}\n\n${imageRefs}`;

      session.prompt(promptText).catch((err: unknown) => {
        console.error("[workflow-bridge] session.prompt() failed", err);
      });
      return;
    }

    session.prompt(text).catch((err: unknown) => {
      console.error("[workflow-bridge] session.prompt() failed", err);
    });
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function handleWorkflowCommand(
  command: string,
  args: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  session: any,
  channel: OpenClawChannel,
  workflowsDir: string,
  configPath: string,
): Promise<void> {
  try {
    const [workflowMd, config] = await Promise.all([
      loadWorkflow(workflowsDir, command as any),
      loadAgentOsConfig(configPath),
    ]);

    // Pi sessions cannot spawn Claude Code subagents — always false.
    const processed = processConditionals(workflowMd, {
      use_claude_code_subagents: false,
    });

    const expanded = expandPrompt(processed, config, args, command as any);

    await session.prompt(expanded);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unknown error loading workflow";
    console.error("[workflow-bridge] workflow expansion failed", err);

    await channel
      .sendMessage(`Failed to load workflow /${command}: ${message}`)
      .catch((sendErr: unknown) => {
        console.error(
          "[workflow-bridge] sendMessage failed for error notification",
          sendErr,
        );
      });
  }
}
