/**
 * Unit tests for plugin.ts
 *
 * Mocks pi-session.ts, channel-bridge.ts, and fleet-memory.ts to avoid
 * requiring the Pi SDK peer dependency at test time.
 *
 * Tests cover:
 *   - Plugin shape (default export has id, name, configSchema, register)
 *   - Registration (7 commands + 1 service)
 *   - Command handling (ack text, async prompt)
 *   - Lazy session initialization + caching
 *   - Service stop lifecycle
 *   - Error paths (missing workflow, session creation failure)
 *   - Channel adapter
 */

import { vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
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

vi.mock("../src/pi-session.js", () => ({
  createHarnessSession: vi.fn(() => Promise.resolve(mockHarnessSession)),
  disposeHarnessSession: vi.fn(),
}));

const mockUnsubscribeBridge = vi.fn();
vi.mock("../src/channel-bridge.js", () => ({
  bridgeSessionToChannel: vi.fn(() => mockUnsubscribeBridge),
}));

vi.mock("../src/fleet-memory.js", () => ({
  configureFleetMemory: vi.fn(() =>
    Promise.resolve({
      endpoint: "http://graphiti:8000",
      groupId: "test-group",
      fallbackPath: "/mock/.memory.json",
      available: true,
    }),
  ),
}));

// Mock fs/promises for loadWorkflow and loadAgentOsConfig
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn((path: string) => {
    if (path.endsWith(".md")) {
      return Promise.resolve("# Mock workflow content");
    }
    if (path.endsWith("config.yml")) {
      return Promise.resolve(`
version: "1.0"
profile: test
use_claude_code_subagents: false
implementation_repos:
  - key: openclaw
    github: zach-source/openclaw-pi-harness
    local_path: /tmp/openclaw
    branch_prefix: spec/
    description: OpenClaw extension
`);
    }
    return Promise.reject(new Error(`ENOENT: no such file: ${path}`));
  }),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
}));

// ---------------------------------------------------------------------------
// Import module under test (after mocks)
// ---------------------------------------------------------------------------

import {
  createHarnessSession,
  disposeHarnessSession,
} from "../src/pi-session.js";
import { bridgeSessionToChannel } from "../src/channel-bridge.js";
import { configureFleetMemory } from "../src/fleet-memory.js";
import { readFile } from "node:fs/promises";
import plugin, {
  _sessionRef,
  _ensureSession,
  adaptChannel,
  type PluginConfig,
} from "../src/plugin.js";
import type {
  GatewayPluginApi,
  GatewayCommandDef,
  GatewayService,
  GatewayChannelRef,
  GatewayCommandContext,
} from "../src/gateway-plugin-types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePluginConfig(): PluginConfig {
  return {
    workspace: "/mock/workspace",
    extensions: ["/mock/ext.ts"],
    heartbeat: { enabled: true, intervalMs: 60_000 },
    harness: { maxWorkers: 3, staggerMs: 5000, tmuxServer: "pi-harness" },
    graphiti: { endpoint: "http://graphiti:8000", groupId: "test-group" },
    workflows: {
      workflowsDir: "/mock/workflows",
      configPath: "/mock/agent-os/config.yml",
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  resetSessionRef();
});

// ---------------------------------------------------------------------------
// Plugin shape
// ---------------------------------------------------------------------------

describe("plugin default export", () => {
  it("has id, name, configSchema, and register", () => {
    expect(plugin.id).toBe("openclaw-pi-harness");
    expect(plugin.name).toBe("OpenClaw Pi Harness");
    expect(plugin.configSchema).toBeDefined();
    expect(typeof plugin.register).toBe("function");
  });

  it("configSchema declares required fields", () => {
    expect(plugin.configSchema.type).toBe("object");
    expect(plugin.configSchema.required).toContain("workspace");
    expect(plugin.configSchema.required).toContain("workflows");
  });
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("register(api)", () => {
  it("registers exactly 7 commands and 1 service", () => {
    const commands: GatewayCommandDef[] = [];
    const services: GatewayService[] = [];

    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: (svc) => services.push(svc),
    };

    plugin.register(api);

    expect(commands).toHaveLength(7);
    expect(services).toHaveLength(1);
  });

  it("registers the correct 7 workflow command names", () => {
    const commandNames: string[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commandNames.push(def.name),
      registerService: () => {},
    };

    plugin.register(api);

    expect(commandNames).toContain("plan-product");
    expect(commandNames).toContain("shape-spec");
    expect(commandNames).toContain("write-spec");
    expect(commandNames).toContain("create-tasks");
    expect(commandNames).toContain("communicate-changes");
    expect(commandNames).toContain("implement-tasks");
    expect(commandNames).toContain("orchestrate-tasks");
  });

  it("all commands accept args", () => {
    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    for (const cmd of commands) {
      expect(cmd.acceptsArgs).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

describe("command handler", () => {
  it('returns ack text "Starting workflow: ..."', async () => {
    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    const shapeSpec = commands.find((c) => c.name === "shape-spec")!;
    const ctx = makeCommandContext({ args: "my-feature" });

    const result = await shapeSpec.handler(ctx);

    expect(result.text).toBe("Starting workflow: shape-spec...");
  });

  it("calls session.piSession.prompt with expanded prompt", async () => {
    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    const writeSpec = commands.find((c) => c.name === "write-spec")!;
    const ctx = makeCommandContext({ args: "auth-module" });

    await writeSpec.handler(ctx);

    // Wait for the fire-and-forget prompt to be called
    await vi.waitFor(() => {
      expect(mockPiSession.prompt).toHaveBeenCalledOnce();
    });

    const promptArg = mockPiSession.prompt.mock.calls[0][0] as string;
    expect(promptArg).toContain("write-spec");
    expect(promptArg).toContain("auth-module");
  });
});

// ---------------------------------------------------------------------------
// Lazy session initialization
// ---------------------------------------------------------------------------

describe("lazy session initialization", () => {
  it("creates session on first command", async () => {
    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    expect(_sessionRef.session).toBeNull();

    const cmd = commands.find((c) => c.name === "plan-product")!;
    await cmd.handler(makeCommandContext());

    expect(createHarnessSession).toHaveBeenCalledOnce();
    expect(bridgeSessionToChannel).toHaveBeenCalledOnce();
    expect(_sessionRef.session).not.toBeNull();
  });

  it("reuses session on subsequent commands", async () => {
    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    const cmd = commands.find((c) => c.name === "plan-product")!;
    await cmd.handler(makeCommandContext());
    await cmd.handler(makeCommandContext());

    expect(createHarnessSession).toHaveBeenCalledOnce();
  });

  it("configures fleet memory when graphiti config is present", async () => {
    const channel = makeGatewayChannel();
    const config = makePluginConfig();

    await _ensureSession(config, channel);

    expect(configureFleetMemory).toHaveBeenCalledOnce();
    expect(_sessionRef.fleetMemory).not.toBeNull();
  });

  it("skips fleet memory when graphiti config is absent", async () => {
    const channel = makeGatewayChannel();
    const config = makePluginConfig();
    delete (config as Partial<PluginConfig>).graphiti;

    await _ensureSession(config, channel);

    expect(configureFleetMemory).not.toHaveBeenCalled();
    expect(_sessionRef.fleetMemory).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service stop
// ---------------------------------------------------------------------------

describe("service stop", () => {
  it("disposes session, calls bridge unsubscribe, nulls sessionRef", async () => {
    let capturedService: GatewayService | null = null;
    const api: GatewayPluginApi = {
      registerCommand: () => {},
      registerService: (svc) => {
        capturedService = svc;
      },
    };

    plugin.register(api);

    // Set up a session first
    const channel = makeGatewayChannel();
    await _ensureSession(makePluginConfig(), channel);

    expect(_sessionRef.session).not.toBeNull();

    // Now call stop
    await capturedService!.stop();

    expect(disposeHarnessSession).toHaveBeenCalledOnce();
    expect(mockUnsubscribeBridge).toHaveBeenCalledOnce();
    expect(_sessionRef.session).toBeNull();
    expect(_sessionRef.unsubscribeBridge).toBeNull();
    expect(_sessionRef.fleetMemory).toBeNull();
    expect(_sessionRef.config).toBeNull();
  });

  it("is safe to call stop when no session exists", async () => {
    let capturedService: GatewayService | null = null;
    const api: GatewayPluginApi = {
      registerCommand: () => {},
      registerService: (svc) => {
        capturedService = svc;
      },
    };

    plugin.register(api);

    // stop without ever creating a session
    await capturedService!.stop();

    expect(disposeHarnessSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe("error paths", () => {
  it("returns error text when workflow file is missing", async () => {
    vi.mocked(readFile).mockRejectedValueOnce(
      new Error("ENOENT: no such file"),
    );

    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    const cmd = commands.find((c) => c.name === "shape-spec")!;
    const result = await cmd.handler(makeCommandContext());

    expect(result.text).toContain("Error loading workflow");
    expect(result.text).toContain("ENOENT");
  });

  it("returns error text when session creation fails", async () => {
    vi.mocked(createHarnessSession).mockRejectedValueOnce(
      new Error("Pi SDK not installed"),
    );

    const commands: GatewayCommandDef[] = [];
    const api: GatewayPluginApi = {
      registerCommand: (def) => commands.push(def),
      registerService: () => {},
    };

    plugin.register(api);

    const cmd = commands.find((c) => c.name === "plan-product")!;
    const result = await cmd.handler(makeCommandContext());

    expect(result.text).toContain("Error initializing session");
    expect(result.text).toContain("Pi SDK not installed");
  });
});

// ---------------------------------------------------------------------------
// Channel adapter
// ---------------------------------------------------------------------------

describe("adaptChannel", () => {
  it("produces a valid OpenClawChannel from GatewayChannelRef", () => {
    const ref = makeGatewayChannel();
    const adapted = adaptChannel(ref);

    expect(typeof adapted.sendMessage).toBe("function");
    expect(typeof adapted.onMessage).toBe("function");
  });

  it("delegates sendMessage to the gateway channel ref", async () => {
    const ref = makeGatewayChannel();
    const adapted = adaptChannel(ref);

    await adapted.sendMessage("hello");

    expect(ref.sent).toEqual(["hello"]);
  });

  it("onMessage is a no-op (does not throw)", () => {
    const ref = makeGatewayChannel();
    const adapted = adaptChannel(ref);

    expect(() => adapted.onMessage(() => {})).not.toThrow();
  });
});
