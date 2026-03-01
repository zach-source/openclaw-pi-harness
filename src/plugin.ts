/**
 * plugin.ts
 *
 * OpenClaw Gateway Plugin entry point. Exports the "object format" plugin
 * descriptor: `{ id, name, configSchema, register }`.
 *
 * The `register(api)` callback wires the harness session lifecycle and
 * the 7 agent-os workflow commands into the gateway's plugin system.
 *
 * Key design decisions:
 *
 * - **Lazy session initialization**: `registerService.start()` is a no-op.
 *   Config arrives via `GatewayCommandContext.config` at command invocation
 *   time, so the session is created on the first command and cached.
 *
 * - **Async prompt, sync ack**: Command handlers return an immediate
 *   `{ text }` acknowledgment. The actual AI response flows back through
 *   `bridgeSessionToChannel`.
 */

import { join } from "node:path";

import { bridgeSessionToChannel } from "./channel-bridge.js";
import {
  expandPrompt,
  loadAgentOsConfig,
  loadWorkflow,
  processConditionals,
  WORKFLOW_COMMANDS,
  type WorkflowCommandName,
} from "./command-router.js";
import { configureFleetMemory } from "./fleet-memory.js";
import type {
  GatewayChannelRef,
  GatewayCommandContext,
  GatewayCommandResult,
  GatewayPluginApi,
} from "./gateway-plugin-types.js";
import {
  createHarnessSession,
  disposeHarnessSession,
  type HarnessSession,
} from "./pi-session.js";
import type { FleetMemoryConfig, OpenClawChannel } from "./types.js";

// ---------------------------------------------------------------------------
// Plugin config
// ---------------------------------------------------------------------------

export interface PluginConfig {
  workspace: string;
  extensions: string[];
  heartbeat: { enabled: boolean; intervalMs: number };
  harness: { maxWorkers: number; staggerMs: number; tmuxServer: string };
  graphiti?: { endpoint: string; groupId: string };
  workflows: { workflowsDir: string; configPath: string };
  notifyOnToolStart?: boolean;
}

// ---------------------------------------------------------------------------
// JSON Schema for config (required by the object format)
// ---------------------------------------------------------------------------

const configSchema = {
  type: "object" as const,
  required: ["workspace", "extensions", "heartbeat", "harness", "workflows"],
  properties: {
    workspace: {
      type: "string",
      description: "Working directory for tool path resolution",
    },
    extensions: {
      type: "array",
      items: { type: "string" },
      description: "Absolute paths to Pi extension files",
    },
    heartbeat: {
      type: "object",
      required: ["enabled", "intervalMs"],
      properties: {
        enabled: { type: "boolean" },
        intervalMs: { type: "number" },
      },
    },
    harness: {
      type: "object",
      required: ["maxWorkers", "staggerMs", "tmuxServer"],
      properties: {
        maxWorkers: { type: "number" },
        staggerMs: { type: "number" },
        tmuxServer: { type: "string" },
      },
    },
    graphiti: {
      type: "object",
      properties: {
        endpoint: { type: "string" },
        groupId: { type: "string" },
      },
    },
    workflows: {
      type: "object",
      required: ["workflowsDir", "configPath"],
      properties: {
        workflowsDir: {
          type: "string",
          description: "Directory containing workflow .md files",
        },
        configPath: {
          type: "string",
          description: "Path to agent-os/config.yml",
        },
      },
    },
    notifyOnToolStart: { type: "boolean" },
  },
};

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

export interface SessionRef {
  session: HarnessSession | null;
  unsubscribeBridge: (() => void) | null;
  fleetMemory: FleetMemoryConfig | null;
  config: PluginConfig | null;
}

export const _sessionRef: SessionRef = {
  session: null,
  unsubscribeBridge: null,
  fleetMemory: null,
  config: null,
};

// ---------------------------------------------------------------------------
// Channel adapter
// ---------------------------------------------------------------------------

/**
 * Adapts a {@link GatewayChannelRef} into an {@link OpenClawChannel}.
 *
 * The gateway channel only has `sendMessage`. `onMessage` is a no-op because
 * the gateway handles inbound routing — messages arrive via command handlers,
 * not via a persistent listener.
 */
export function adaptChannel(ref: GatewayChannelRef): OpenClawChannel {
  return {
    sendMessage: (text: string) => ref.sendMessage(text),
    onMessage: () => {
      /* no-op: gateway handles inbound routing */
    },
  };
}

// ---------------------------------------------------------------------------
// Lazy session initializer
// ---------------------------------------------------------------------------

/**
 * Creates (or returns the cached) harness session, wires the channel bridge,
 * and configures fleet memory.
 */
export async function _ensureSession(
  config: PluginConfig,
  channel: GatewayChannelRef,
): Promise<HarnessSession> {
  if (_sessionRef.session !== null) {
    return _sessionRef.session;
  }

  const session = await createHarnessSession({
    workspace: config.workspace,
    extensions: config.extensions,
    heartbeat: config.heartbeat,
    harness: config.harness,
    graphiti: config.graphiti,
  });

  const openClawChannel = adaptChannel(channel);
  const unsubscribeBridge = bridgeSessionToChannel(
    session.piSession,
    openClawChannel,
    { notifyOnToolStart: config.notifyOnToolStart ?? false },
  );

  let fleetMemory: FleetMemoryConfig | null = null;
  if (config.graphiti) {
    fleetMemory = await configureFleetMemory({
      endpoint: config.graphiti.endpoint,
      groupId: config.graphiti.groupId,
      fallbackPath: join(config.workspace, ".run", ".memory.json"),
    });
  }

  _sessionRef.session = session;
  _sessionRef.unsubscribeBridge = unsubscribeBridge;
  _sessionRef.fleetMemory = fleetMemory;
  _sessionRef.config = config;

  return session;
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

const WORKFLOW_DESCRIPTIONS: Record<WorkflowCommandName, string> = {
  "plan-product": "Plan product vision, roadmap, and tech stack",
  "shape-spec": "Initialize and scope a new feature specification",
  "write-spec": "Write a formal feature specification",
  "create-tasks": "Break a specification into implementable tasks",
  "communicate-changes": "Create a PR in target repository",
  "implement-tasks": "Implement tasks (simple mode)",
  "orchestrate-tasks": "Implement tasks (multi-agent mode)",
};

async function handleWorkflowCommand(
  name: WorkflowCommandName,
  ctx: GatewayCommandContext,
): Promise<GatewayCommandResult> {
  const config = ctx.config as unknown as PluginConfig;

  let session: HarnessSession;
  try {
    session = await _ensureSession(config, ctx.channel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Error initializing session: ${msg}` };
  }

  let workflowMd: string;
  try {
    workflowMd = await loadWorkflow(config.workflows.workflowsDir, name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Error loading workflow "${name}": ${msg}` };
  }

  let agentOsConfig;
  try {
    agentOsConfig = await loadAgentOsConfig(config.workflows.configPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `Error loading agent-os config: ${msg}` };
  }

  const processed = processConditionals(workflowMd, {
    use_claude_code_subagents: agentOsConfig.use_claude_code_subagents,
  });
  const expanded = expandPrompt(processed, agentOsConfig, ctx.args, name);

  // Fire-and-forget: the AI response flows back via the session-to-channel bridge
  session.piSession.prompt(expanded).catch((err: unknown) => {
    console.error(`[plugin] prompt failed for workflow "${name}"`, err);
  });

  return { text: `Starting workflow: ${name}...` };
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

function register(api: GatewayPluginApi): void {
  // Register service lifecycle
  api.registerService({
    start() {
      // No-op: session is lazily created on first command invocation
    },
    async stop() {
      if (_sessionRef.unsubscribeBridge) {
        _sessionRef.unsubscribeBridge();
      }
      if (_sessionRef.session) {
        disposeHarnessSession(_sessionRef.session);
      }
      _sessionRef.session = null;
      _sessionRef.unsubscribeBridge = null;
      _sessionRef.fleetMemory = null;
      _sessionRef.config = null;
    },
  });

  // Register workflow commands
  for (const name of WORKFLOW_COMMANDS) {
    api.registerCommand({
      name,
      description: WORKFLOW_DESCRIPTIONS[name],
      acceptsArgs: true,
      handler: (ctx) => handleWorkflowCommand(name, ctx),
    });
  }
}

// ---------------------------------------------------------------------------
// Default export: Gateway Plugin object format
// ---------------------------------------------------------------------------

export default {
  id: "openclaw-pi-harness",
  name: "OpenClaw Pi Harness",
  configSchema,
  register,
};
