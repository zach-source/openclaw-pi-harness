/**
 * Unit tests for command-router.ts
 *
 * Tests cover:
 *   - parseMessage: all 7 commands, args extraction, passthrough cases
 *   - loadAgentOsConfig: parse real config, missing file, malformed YAML
 *   - loadWorkflow: load each of 7 workflows, missing file
 *   - expandPrompt: context frame, repo table, workflow content, args
 *   - processConditionals: IF true/false, UNLESS true/false
 *   - unknownCommandMessage: lists all commands, includes attempted name
 */

import { join } from "node:path";
import {
  expandPrompt,
  loadAgentOsConfig,
  loadWorkflow,
  parseMessage,
  processConditionals,
  unknownCommandMessage,
  WORKFLOW_COMMANDS,
} from "../src/command-router.js";
import type {
  AgentOsConfig,
  WorkflowCommandName,
} from "../src/command-router.js";

// ---------------------------------------------------------------------------
// Paths to real project fixtures
// ---------------------------------------------------------------------------

const FIXTURES_CONFIG = join(
  import.meta.dirname,
  "..",
  "agent-os",
  "config.yml",
);
const FIXTURES_WORKFLOWS = join(import.meta.dirname, "..", "workflows");

// ---------------------------------------------------------------------------
// parseMessage
// ---------------------------------------------------------------------------

describe("parseMessage", () => {
  const allCommands: WorkflowCommandName[] = [
    "plan-product",
    "shape-spec",
    "write-spec",
    "create-tasks",
    "communicate-changes",
    "implement-tasks",
    "orchestrate-tasks",
  ];

  it.each(allCommands)("recognises /%s as a workflow command", (cmd) => {
    const result = parseMessage(`/${cmd}`);
    expect(result).toEqual({ kind: "command", command: cmd, args: "" });
  });

  it("extracts args after the command name", () => {
    const result = parseMessage("/shape-spec my cool feature");
    expect(result).toEqual({
      kind: "command",
      command: "shape-spec",
      args: "my cool feature",
    });
  });

  it("trims leading/trailing whitespace from the message", () => {
    const result = parseMessage("  /write-spec  some args  ");
    expect(result).toEqual({
      kind: "command",
      command: "write-spec",
      args: "some args",
    });
  });

  it("passes through /run as-is", () => {
    const result = parseMessage("/run deploy");
    expect(result).toEqual({ kind: "passthrough", text: "/run deploy" });
  });

  it("passes through /run:status as-is", () => {
    const result = parseMessage("/run:status");
    expect(result).toEqual({ kind: "passthrough", text: "/run:status" });
  });

  it("passes through /run:stop as-is", () => {
    const result = parseMessage("/run:stop");
    expect(result).toEqual({ kind: "passthrough", text: "/run:stop" });
  });

  it("passes through plain text", () => {
    const result = parseMessage("hello world");
    expect(result).toEqual({ kind: "passthrough", text: "hello world" });
  });

  it("passes through an empty string", () => {
    const result = parseMessage("");
    expect(result).toEqual({ kind: "passthrough", text: "" });
  });

  it("passes through whitespace-only input", () => {
    const result = parseMessage("   ");
    expect(result).toEqual({ kind: "passthrough", text: "   " });
  });

  it("passes through unknown slash commands", () => {
    const result = parseMessage("/unknown-thing");
    expect(result).toEqual({ kind: "passthrough", text: "/unknown-thing" });
  });
});

// ---------------------------------------------------------------------------
// loadAgentOsConfig
// ---------------------------------------------------------------------------

describe("loadAgentOsConfig", () => {
  it("parses the real agent-os/config.yml", async () => {
    const config = await loadAgentOsConfig(FIXTURES_CONFIG);

    expect(config.version).toBe("2.1.1");
    expect(config.profile).toBe("ztaylor");
    expect(config.use_claude_code_subagents).toBe(true);
    expect(config.implementation_repos).toBeInstanceOf(Array);
    expect(config.implementation_repos.length).toBeGreaterThanOrEqual(1);

    const openclaw = config.implementation_repos.find(
      (r) => r.key === "openclaw",
    );
    expect(openclaw).toBeDefined();
    expect(openclaw!.github).toBe("zach-source/openclaw-pi-harness");
  });

  it("throws for a missing config file", async () => {
    await expect(
      loadAgentOsConfig("/nonexistent/config.yml"),
    ).rejects.toThrow();
  });

  it("throws for malformed YAML (non-object)", async () => {
    // A YAML file that parses to a plain string, not an object.
    const { writeFile, unlink } = await import("node:fs/promises");
    const tmpPath = join(import.meta.dirname, "..", ".tmp-test-config.yml");

    await writeFile(tmpPath, "just a string\n", "utf-8");
    try {
      await expect(loadAgentOsConfig(tmpPath)).rejects.toThrow(
        /Malformed config/,
      );
    } finally {
      await unlink(tmpPath).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// loadWorkflow
// ---------------------------------------------------------------------------

describe("loadWorkflow", () => {
  const allCommands: WorkflowCommandName[] = [...WORKFLOW_COMMANDS];

  it.each(allCommands)("loads workflows/%s.md", async (cmd) => {
    const md = await loadWorkflow(FIXTURES_WORKFLOWS, cmd);
    expect(md.length).toBeGreaterThan(0);
    expect(typeof md).toBe("string");
  });

  it("throws when the workflow file does not exist", async () => {
    await expect(
      loadWorkflow(FIXTURES_WORKFLOWS, "nonexistent" as WorkflowCommandName),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// processConditionals
// ---------------------------------------------------------------------------

describe("processConditionals", () => {
  it("keeps IF block content when flag is true", () => {
    const md = "before\n{{IF my_flag}}\nkept\n{{ENDIF my_flag}}\nafter";
    const result = processConditionals(md, { my_flag: true });
    expect(result).toContain("kept");
    expect(result).toContain("before");
    expect(result).toContain("after");
    expect(result).not.toContain("{{IF");
  });

  it("strips IF block content when flag is false", () => {
    const md = "before\n{{IF my_flag}}\nremoved\n{{ENDIF my_flag}}\nafter";
    const result = processConditionals(md, { my_flag: false });
    expect(result).not.toContain("removed");
    expect(result).toContain("before");
    expect(result).toContain("after");
  });

  it("keeps UNLESS block content when flag is false", () => {
    const md = "before\n{{UNLESS my_flag}}\nkept\n{{ENDUNLESS my_flag}}\nafter";
    const result = processConditionals(md, { my_flag: false });
    expect(result).toContain("kept");
  });

  it("strips UNLESS block content when flag is true", () => {
    const md =
      "before\n{{UNLESS my_flag}}\nremoved\n{{ENDUNLESS my_flag}}\nafter";
    const result = processConditionals(md, { my_flag: true });
    expect(result).not.toContain("removed");
  });

  it("treats unknown flags as false", () => {
    const md = "{{IF unknown}}\nhidden\n{{ENDIF unknown}}\nvisible";
    const result = processConditionals(md, {});
    expect(result).not.toContain("hidden");
    expect(result).toContain("visible");
  });

  it("handles both IF and UNLESS for the same flag", () => {
    const md = [
      "{{IF use_claude_code_subagents}}",
      "subagent path",
      "{{ENDIF use_claude_code_subagents}}",
      "{{UNLESS use_claude_code_subagents}}",
      "prompt path",
      "{{ENDUNLESS use_claude_code_subagents}}",
    ].join("\n");

    const withSubagents = processConditionals(md, {
      use_claude_code_subagents: true,
    });
    expect(withSubagents).toContain("subagent path");
    expect(withSubagents).not.toContain("prompt path");

    const withoutSubagents = processConditionals(md, {
      use_claude_code_subagents: false,
    });
    expect(withoutSubagents).not.toContain("subagent path");
    expect(withoutSubagents).toContain("prompt path");
  });
});

// ---------------------------------------------------------------------------
// expandPrompt
// ---------------------------------------------------------------------------

describe("expandPrompt", () => {
  const config: AgentOsConfig = {
    version: "2.0.0",
    profile: "test",
    use_claude_code_subagents: false,
    implementation_repos: [
      {
        key: "myrepo",
        github: "org/myrepo",
        local_path: "../myrepo",
        branch_prefix: "spec/",
        description: "Test repo",
        test_command: "npm test",
        build_command: "npm run build",
      },
    ],
  };

  it("includes the context frame", () => {
    const result = expandPrompt(
      "# Workflow\nDo stuff",
      config,
      "",
      "shape-spec",
    );
    expect(result).toContain("## Workflow Context");
    expect(result).toContain("Execute inline");
    expect(result).toContain("Stop and wait");
    expect(result).toContain("No auto-chaining");
  });

  it("includes the repo configuration table", () => {
    const result = expandPrompt("# Workflow", config, "", "shape-spec");
    expect(result).toContain("### Repository Configuration");
    expect(result).toContain("| myrepo |");
    expect(result).toContain("org/myrepo");
    expect(result).toContain("npm test");
    expect(result).toContain("npm run build");
  });

  it("includes the workflow content", () => {
    const workflowContent = "# Shape Spec\n\nDo the shaping.";
    const result = expandPrompt(workflowContent, config, "", "shape-spec");
    expect(result).toContain("## Workflow: shape-spec");
    expect(result).toContain("Do the shaping.");
  });

  it("includes user args in the request section", () => {
    const result = expandPrompt(
      "# Workflow",
      config,
      "my cool feature",
      "shape-spec",
    );
    expect(result).toContain("The user invoked: /shape-spec my cool feature");
  });

  it("handles empty args gracefully", () => {
    const result = expandPrompt("# Workflow", config, "", "write-spec");
    expect(result).toContain("The user invoked: /write-spec");
    expect(result).not.toContain("The user invoked: /write-spec ");
  });

  it("uses em-dash for missing test/build commands", () => {
    const sparseConfig: AgentOsConfig = {
      ...config,
      implementation_repos: [
        {
          key: "bare",
          github: "org/bare",
          local_path: "../bare",
          branch_prefix: "feat/",
          description: "Bare repo",
        },
      ],
    };
    const result = expandPrompt("# W", sparseConfig, "", "plan-product");
    // Should contain em-dash for missing commands
    expect(result).toContain("| bare |");
    expect(result).toContain("—");
  });
});

// ---------------------------------------------------------------------------
// unknownCommandMessage
// ---------------------------------------------------------------------------

describe("unknownCommandMessage", () => {
  it("includes the attempted command name", () => {
    const msg = unknownCommandMessage("foo-bar");
    expect(msg).toContain("Unknown command: /foo-bar");
  });

  it("lists all 7 available workflow commands", () => {
    const msg = unknownCommandMessage("test");
    for (const cmd of WORKFLOW_COMMANDS) {
      expect(msg).toContain(`/${cmd}`);
    }
  });

  it("includes passthrough hint", () => {
    const msg = unknownCommandMessage("x");
    expect(msg).toContain("sent directly to the agent session");
  });
});
