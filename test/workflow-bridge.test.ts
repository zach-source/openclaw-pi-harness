/**
 * Unit tests for workflow-bridge.ts
 *
 * Tests cover:
 *   - Routes workflow commands through expansion to session.prompt
 *   - Passes non-commands through unmodified
 *   - Passes /run through unmodified
 *   - Error handling: sends error to channel when workflow file missing
 *   - Unknown command suggestion behaviour
 *   - Image passthrough (promptWithImages and URL fallback)
 */

import { join } from "node:path";
import { bridgeChannelToSessionWithWorkflows } from "../src/workflow-bridge.js";
import type { WorkflowBridgeOptions } from "../src/workflow-bridge.js";
import type { OpenClawChannel } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared fixtures (mirrors channel-bridge.test.ts pattern)
// ---------------------------------------------------------------------------

function makeChannel(): {
  channel: OpenClawChannel;
  sent: string[];
  messageHandler: ((text: string, images?: string[]) => void) | null;
} {
  const sent: string[] = [];
  let messageHandler: ((text: string, images?: string[]) => void) | null = null;

  const channel: OpenClawChannel = {
    async sendMessage(text: string): Promise<void> {
      sent.push(text);
    },
    onMessage(handler: (text: string, images?: string[]) => void): void {
      messageHandler = handler;
    },
  };

  return {
    channel,
    sent,
    get messageHandler() {
      return messageHandler;
    },
  };
}

function makeSession() {
  return {
    prompt: vi.fn(() => Promise.resolve()),
    promptWithImages: vi.fn(() => Promise.resolve()),
  };
}

// Paths to real project fixtures.
const FIXTURES_CONFIG = join(
  import.meta.dirname,
  "..",
  "agent-os",
  "config.yml",
);
const FIXTURES_WORKFLOWS = join(import.meta.dirname, "..", "workflows");

const defaultOptions: WorkflowBridgeOptions = {
  workflowsDir: FIXTURES_WORKFLOWS,
  configPath: FIXTURES_CONFIG,
};

// ---------------------------------------------------------------------------
// Workflow command routing
// ---------------------------------------------------------------------------

describe("bridgeChannelToSessionWithWorkflows", () => {
  it("expands a workflow command and sends expanded prompt to session", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    fixture.messageHandler!("/shape-spec my feature");

    // Wait for the async handleWorkflowCommand to complete.
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    const expandedPrompt = session.prompt.mock.calls[0][0] as string;
    expect(expandedPrompt).toContain("## Workflow Context");
    expect(expandedPrompt).toContain("## Workflow: shape-spec");
    expect(expandedPrompt).toContain(
      "The user invoked: /shape-spec my feature",
    );
    expect(expandedPrompt).toContain("### Repository Configuration");
    // Conditionals: use_claude_code_subagents should be false for Pi sessions.
    // The orchestrate-tasks workflow has IF/UNLESS blocks; shape-spec doesn't,
    // but the context frame is always present.
    expect(expandedPrompt).toContain("Execute inline");
  });

  it("passes plain text through to session.prompt unmodified", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    fixture.messageHandler!("hello world");

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    expect(session.prompt).toHaveBeenCalledWith("hello world");
  });

  it("passes /run through to session.prompt unmodified", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    fixture.messageHandler!("/run deploy");

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    expect(session.prompt).toHaveBeenCalledWith("/run deploy");
  });

  it("sends error to channel when workflow file is missing", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(fixture.channel, session, {
      workflowsDir: "/nonexistent/workflows",
      configPath: FIXTURES_CONFIG,
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    fixture.messageHandler!("/shape-spec");

    await vi.waitFor(() => {
      expect(fixture.sent.length).toBeGreaterThan(0);
    });

    expect(fixture.sent[0]).toContain("Failed to load workflow /shape-spec");
    expect(session.prompt).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
  });

  // ---------------------------------------------------------------------------
  // Unknown command suggestion
  // ---------------------------------------------------------------------------

  it("sends help message for unknown hyphenated slash-commands", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    fixture.messageHandler!("/do-something");

    await vi.waitFor(() => {
      expect(fixture.sent.length).toBeGreaterThan(0);
    });

    expect(fixture.sent[0]).toContain("Unknown command: /do-something");
    expect(fixture.sent[0]).toContain("/shape-spec");
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("does NOT suggest for unknown commands when suggestOnUnknownCommand is false", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(fixture.channel, session, {
      ...defaultOptions,
      suggestOnUnknownCommand: false,
    });

    fixture.messageHandler!("/do-something");

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    // Should pass through to session.prompt, not to channel.
    expect(session.prompt).toHaveBeenCalledWith("/do-something");
    expect(fixture.sent).toHaveLength(0);
  });

  it("does NOT suggest for /run (non-hyphenated known passthrough)", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    fixture.messageHandler!("/run deploy");

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    expect(fixture.sent).toHaveLength(0);
    expect(session.prompt).toHaveBeenCalledWith("/run deploy");
  });

  // ---------------------------------------------------------------------------
  // Image passthrough
  // ---------------------------------------------------------------------------

  it("uses session.promptWithImages when session supports it and images are present", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    const images = ["https://example.com/img1.png"];
    fixture.messageHandler!("check this", images);

    await vi.waitFor(() => {
      expect(session.promptWithImages).toHaveBeenCalledOnce();
    });

    expect(session.promptWithImages).toHaveBeenCalledWith("check this", images);
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it("falls back to session.prompt with appended image URLs when session lacks promptWithImages", async () => {
    const session = { prompt: vi.fn(() => Promise.resolve()) };
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    const images = ["https://example.com/a.png", "https://example.com/b.png"];
    fixture.messageHandler!("two images", images);

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    const promptArg = session.prompt.mock.calls[0][0] as string;
    expect(promptArg).toContain("two images");
    expect(promptArg).toContain("[image 1]: https://example.com/a.png");
    expect(promptArg).toContain("[image 2]: https://example.com/b.png");
  });

  it("processes conditionals with use_claude_code_subagents=false on orchestrate-tasks", async () => {
    const session = makeSession();
    const fixture = makeChannel();

    bridgeChannelToSessionWithWorkflows(
      fixture.channel,
      session,
      defaultOptions,
    );

    fixture.messageHandler!("/orchestrate-tasks");

    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalledOnce();
    });

    const expandedPrompt = session.prompt.mock.calls[0][0] as string;
    // The UNLESS block (prompt-generation path) should be kept.
    expect(expandedPrompt).toContain("Generate prompts");
    // The IF block (subagent delegation) should be stripped.
    expect(expandedPrompt).not.toContain("Ask user to assign subagents");
  });
});
