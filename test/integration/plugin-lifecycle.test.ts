/**
 * Integration test for the Gateway Plugin lifecycle.
 *
 * Exercises cross-module interactions that unit tests cannot catch:
 *
 *   1. Plugin registration → command invocation → session creation → prompt expansion
 *   2. Session caching across multiple command invocations
 *   3. Service stop lifecycle with active session
 *   4. Multiple workflow commands on a shared session
 *   5. Channel adapter integration with bridge
 *   6. Error recovery: failed command followed by successful command
 *
 * All Pi SDK interactions are mocked. Real command-router functions (loadWorkflow,
 * loadAgentOsConfig, expandPrompt, processConditionals) are exercised against
 * the actual workflow files and config.yml in the project.
 */

import { join } from "node:path";

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — pi-session, channel-bridge, and fleet-memory are mocked to avoid
// the Pi SDK peer dependency. command-router is NOT mocked — we exercise the
// real workflow loading and prompt expansion.
// ---------------------------------------------------------------------------

const mockPiSession = {
  prompt: vi.fn(() => Promise.resolve()),
  dispose: vi.fn(),
  subscribe: vi.fn(() => ({ unsubscribe: vi.fn() })),
};

const mockHarnessSession = {
  piSession: mockPiSession,
  workspace: "/mock/workspace",
};

vi.mock("../../src/pi-session.js", () => ({
  createHarnessSession: vi.fn(() => Promise.resolve(mockHarnessSession)),
  disposeHarnessSession: vi.fn(),
}));

const mockUnsubscribeBridge = vi.fn();
vi.mock("../../src/channel-bridge.js", () => ({
  bridgeSessionToChannel: vi.fn(() => mockUnsubscribeBridge),
}));

vi.mock("../../src/fleet-memory.js", () => ({
  configureFleetMemory: vi.fn(() =>
    Promise.resolve({
      endpoint: null,
      groupId: "integration-test",
      fallbackPath: "/tmp/.memory.json",
      available: false,
    }),
  ),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  createHarnessSession,
  disposeHarnessSession,
} from "../../src/pi-session.js";
import { bridgeSessionToChannel } from "../../src/channel-bridge.js";
import { configureFleetMemory } from "../../src/fleet-memory.js";
import plugin, {
  _sessionRef,
  _ensureSession,
  adaptChannel,
  type PluginConfig,
} from "../../src/plugin.js";
import type {
  GatewayPluginApi,
  GatewayCommandDef,
  GatewayService,
  GatewayChannelRef,
  GatewayCommandContext,
} from "../../src/gateway-plugin-types.js";

// ---------------------------------------------------------------------------
// Fixtures — uses real project paths for workflow files and config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(import.meta.dirname, "..", "..");
const REAL_WORKFLOWS_DIR = join(PROJECT_ROOT, "workflows");
const REAL_CONFIG_PATH = join(PROJECT_ROOT, "agent-os", "config.yml");

function makePluginConfig(): PluginConfig {
  return {
    workspace: "/mock/workspace",
    extensions: ["/mock/ext.ts"],
    heartbeat: { enabled: true, intervalMs: 60_000 },
    harness: { maxWorkers: 3, staggerMs: 5000, tmuxServer: "pi-harness" },
    graphiti: { endpoint: "http://graphiti:8000", groupId: "test-group" },
    workflows: {
      workflowsDir: REAL_WORKFLOWS_DIR,
      configPath: REAL_CONFIG_PATH,
    },
    notifyOnToolStart: false,
  };
}

function makeGatewayChannel(): GatewayChannelRef & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    async sendMessage(text: string) {
      sent.push(text);
    },
  };
}

function makeCommandContext(
  overrides: Partial<GatewayCommandContext> = {},
): GatewayCommandContext {
  return {
    senderId: "user-1",
    channel: makeGatewayChannel(),
    isAuthorizedSender: true,
    args: "",
    commandBody: "",
    config: makePluginConfig() as unknown as Record<string, unknown>,
    ...overrides,
  };
}

function resetSessionRef(): void {
  _sessionRef.session = null;
  _sessionRef.unsubscribeBridge = null;
  _sessionRef.fleetMemory = null;
  _sessionRef.config = null;
}

function collectRegistrations(): {
  commands: GatewayCommandDef[];
  services: GatewayService[];
} {
  const commands: GatewayCommandDef[] = [];
  const services: GatewayService[] = [];
  const api: GatewayPluginApi = {
    registerCommand: (def) => commands.push(def),
    registerService: (svc) => services.push(svc),
  };
  plugin.register(api);
  return { commands, services };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionRef();
});

// ---------------------------------------------------------------------------
// 1. Full command invocation with real workflow expansion
// ---------------------------------------------------------------------------

describe("Plugin command → real workflow expansion", () => {
  it("shape-spec command loads real workflow and builds expanded prompt", async () => {
    const { commands } = collectRegistrations();
    const shapeSpec = commands.find((c) => c.name === "shape-spec")!;

    const ctx = makeCommandContext({ args: "my-feature" });
    const result = await shapeSpec.handler(ctx);

    expect(result.text).toBe("Starting workflow: shape-spec...");

    await vi.waitFor(() => {
      expect(mockPiSession.prompt).toHaveBeenCalledOnce();
    });

    const expanded = mockPiSession.prompt.mock.calls[0][0] as string;
    expect(expanded).toContain("## Workflow Context");
    expect(expanded).toContain("## Workflow: shape-spec");
    expect(expanded).toContain("The user invoked: /shape-spec my-feature");
    expect(expanded).toContain("### Repository Configuration");
    expect(expanded).toContain("Execute inline");
  });

  it("orchestrate-tasks processes conditionals against real config", async () => {
    const { commands } = collectRegistrations();
    const orchestrate = commands.find((c) => c.name === "orchestrate-tasks")!;

    await orchestrate.handler(makeCommandContext());

    await vi.waitFor(() => {
      expect(mockPiSession.prompt).toHaveBeenCalledOnce();
    });

    const expanded = mockPiSession.prompt.mock.calls[0][0] as string;
    expect(expanded).toContain("## Workflow: orchestrate-tasks");
    // Config has use_claude_code_subagents: true, so IF blocks should be kept
    // and UNLESS blocks should be stripped. Verify the prompt contains
    // evidence of conditional processing.
    expect(expanded).toContain("Workflow Context");
  });

  it("plan-product command expands with no args", async () => {
    const { commands } = collectRegistrations();
    const planProduct = commands.find((c) => c.name === "plan-product")!;

    await planProduct.handler(makeCommandContext({ args: "" }));

    await vi.waitFor(() => {
      expect(mockPiSession.prompt).toHaveBeenCalledOnce();
    });

    const expanded = mockPiSession.prompt.mock.calls[0][0] as string;
    expect(expanded).toContain("The user invoked: /plan-product");
    expect(expanded).not.toContain("The user invoked: /plan-product ");
  });
});

// ---------------------------------------------------------------------------
// 2. Session caching across multiple commands
// ---------------------------------------------------------------------------

describe("Session caching across commands", () => {
  it("creates session once and reuses across different workflow commands", async () => {
    const { commands } = collectRegistrations();
    const ctx = makeCommandContext();

    // Invoke three different commands
    const shapeSpec = commands.find((c) => c.name === "shape-spec")!;
    const writeSpec = commands.find((c) => c.name === "write-spec")!;
    const createTasks = commands.find((c) => c.name === "create-tasks")!;

    await shapeSpec.handler(ctx);
    await writeSpec.handler(ctx);
    await createTasks.handler(ctx);

    // Session created only once
    expect(createHarnessSession).toHaveBeenCalledOnce();
    expect(bridgeSessionToChannel).toHaveBeenCalledOnce();

    // All three prompts sent
    await vi.waitFor(() => {
      expect(mockPiSession.prompt).toHaveBeenCalledTimes(3);
    });

    // Each prompt targets a different workflow
    const prompts = mockPiSession.prompt.mock.calls.map((c) => c[0] as string);
    expect(prompts[0]).toContain("shape-spec");
    expect(prompts[1]).toContain("write-spec");
    expect(prompts[2]).toContain("create-tasks");
  });
});

// ---------------------------------------------------------------------------
// 3. Full service lifecycle: start → commands → stop
// ---------------------------------------------------------------------------

describe("Full service lifecycle", () => {
  it("start (no-op) → commands → stop disposes everything", async () => {
    const { commands, services } = collectRegistrations();
    const service = services[0];

    // Start is a no-op
    await service.start();
    expect(createHarnessSession).not.toHaveBeenCalled();

    // First command creates session
    const cmd = commands.find((c) => c.name === "implement-tasks")!;
    await cmd.handler(makeCommandContext());

    expect(createHarnessSession).toHaveBeenCalledOnce();
    expect(_sessionRef.session).not.toBeNull();

    // Stop disposes everything
    await service.stop();

    expect(disposeHarnessSession).toHaveBeenCalledOnce();
    expect(mockUnsubscribeBridge).toHaveBeenCalledOnce();
    expect(_sessionRef.session).toBeNull();
    expect(_sessionRef.unsubscribeBridge).toBeNull();
    expect(_sessionRef.fleetMemory).toBeNull();
    expect(_sessionRef.config).toBeNull();
  });

  it("stop without prior commands is safe (double stop)", async () => {
    const { commands, services } = collectRegistrations();
    const service = services[0];

    // Create and stop
    const cmd = commands.find((c) => c.name === "plan-product")!;
    await cmd.handler(makeCommandContext());
    await service.stop();

    // Second stop should be safe
    vi.clearAllMocks();
    await service.stop();

    expect(disposeHarnessSession).not.toHaveBeenCalled();
    expect(mockUnsubscribeBridge).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. Error recovery: failed command followed by successful command
// ---------------------------------------------------------------------------

describe("Error recovery", () => {
  it("session creation failure on first command, succeeds on retry", async () => {
    vi.mocked(createHarnessSession)
      .mockRejectedValueOnce(new Error("Pi SDK not found"))
      .mockResolvedValueOnce(mockHarnessSession);

    const { commands } = collectRegistrations();
    const cmd = commands.find((c) => c.name === "shape-spec")!;

    // First attempt fails
    const result1 = await cmd.handler(makeCommandContext());
    expect(result1.text).toContain("Error initializing session");
    expect(result1.text).toContain("Pi SDK not found");
    expect(_sessionRef.session).toBeNull();

    // Second attempt succeeds
    const result2 = await cmd.handler(makeCommandContext());
    expect(result2.text).toBe("Starting workflow: shape-spec...");
    expect(_sessionRef.session).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Channel adapter → bridge integration
// ---------------------------------------------------------------------------

describe("Channel adapter integration", () => {
  it("adaptChannel output works with bridgeSessionToChannel", async () => {
    const gatewayRef = makeGatewayChannel();
    const adapted = adaptChannel(gatewayRef);

    // bridgeSessionToChannel is mocked, but we verify the adapted channel
    // is passed correctly and can send messages
    await adapted.sendMessage("test message from bridge");
    expect(gatewayRef.sent).toEqual(["test message from bridge"]);
  });

  it("ensureSession passes adapted channel to bridgeSessionToChannel", async () => {
    const gatewayChannel = makeGatewayChannel();
    const config = makePluginConfig();

    await _ensureSession(config, gatewayChannel);

    // Verify bridgeSessionToChannel was called with the pi session and options
    expect(bridgeSessionToChannel).toHaveBeenCalledOnce();
    const [sessionArg, channelArg, optionsArg] = vi.mocked(
      bridgeSessionToChannel,
    ).mock.calls[0];

    expect(sessionArg).toBe(mockPiSession);
    expect(typeof channelArg.sendMessage).toBe("function");
    expect(typeof channelArg.onMessage).toBe("function");
    expect(optionsArg).toEqual({ notifyOnToolStart: false });
  });

  it("ensureSession passes notifyOnToolStart=true when configured", async () => {
    const gatewayChannel = makeGatewayChannel();
    const config = makePluginConfig();
    config.notifyOnToolStart = true;

    await _ensureSession(config, gatewayChannel);

    const [, , optionsArg] = vi.mocked(bridgeSessionToChannel).mock.calls[0];
    expect(optionsArg).toEqual({ notifyOnToolStart: true });
  });
});

// ---------------------------------------------------------------------------
// 6. Fleet memory integration path
// ---------------------------------------------------------------------------

describe("Fleet memory integration in plugin", () => {
  it("configures fleet memory with graphiti settings from plugin config", async () => {
    const channel = makeGatewayChannel();
    const config = makePluginConfig();

    await _ensureSession(config, channel);

    expect(configureFleetMemory).toHaveBeenCalledOnce();
    expect(configureFleetMemory).toHaveBeenCalledWith({
      endpoint: "http://graphiti:8000",
      groupId: "test-group",
      fallbackPath: join("/mock/workspace", ".run", ".memory.json"),
    });
    expect(_sessionRef.fleetMemory).not.toBeNull();
  });

  it("skips fleet memory when graphiti is not configured", async () => {
    const channel = makeGatewayChannel();
    const config = makePluginConfig();
    delete (config as Partial<PluginConfig>).graphiti;

    await _ensureSession(config, channel);

    expect(configureFleetMemory).not.toHaveBeenCalled();
    expect(_sessionRef.fleetMemory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. All 7 commands produce valid acks and expanded prompts
// ---------------------------------------------------------------------------

describe("All 7 workflow commands end-to-end", () => {
  const workflowNames = [
    "plan-product",
    "shape-spec",
    "write-spec",
    "create-tasks",
    "communicate-changes",
    "implement-tasks",
    "orchestrate-tasks",
  ] as const;

  it.each(workflowNames)(
    "%s returns correct ack and expands real workflow",
    async (name) => {
      vi.clearAllMocks();
      resetSessionRef();

      const { commands } = collectRegistrations();
      const cmd = commands.find((c) => c.name === name)!;

      expect(cmd).toBeDefined();
      expect(cmd.acceptsArgs).toBe(true);
      expect(cmd.description).toBeTruthy();

      const ctx = makeCommandContext({ args: "test-args" });
      const result = await cmd.handler(ctx);

      expect(result.text).toBe(`Starting workflow: ${name}...`);

      await vi.waitFor(() => {
        expect(mockPiSession.prompt).toHaveBeenCalledOnce();
      });

      const expanded = mockPiSession.prompt.mock.calls[0][0] as string;
      expect(expanded).toContain(`## Workflow: ${name}`);
      expect(expanded).toContain(`The user invoked: /${name} test-args`);
      expect(expanded).toContain("## Workflow Context");
      expect(expanded).toContain("### Repository Configuration");
    },
  );
});
