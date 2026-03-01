/**
 * command-router.ts
 *
 * Intercepts agent-os workflow commands from messaging channels, loads the
 * workflow markdown + repo configuration, and builds an expanded prompt so the
 * Pi session can execute the full workflow pipeline.
 *
 * Only the 7 agent-os workflow names are intercepted. All other input
 * (including `/run`, `/run:status`, etc.) passes through unchanged.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The 7 agent-os workflow command names. */
export type WorkflowCommandName =
  | "plan-product"
  | "shape-spec"
  | "write-spec"
  | "create-tasks"
  | "communicate-changes"
  | "implement-tasks"
  | "orchestrate-tasks";

/** Result of parsing an incoming message. */
export type ParsedMessage =
  | { kind: "command"; command: WorkflowCommandName; args: string }
  | { kind: "passthrough"; text: string };

/** A single implementation repo entry from `agent-os/config.yml`. */
export interface RepoTarget {
  key: string;
  github: string;
  local_path: string;
  branch_prefix: string;
  description: string;
  test_command?: string;
  build_command?: string;
  lint_command?: string;
}

/** Typed representation of `agent-os/config.yml`. */
export interface AgentOsConfig {
  version: string;
  profile: string;
  use_claude_code_subagents: boolean;
  implementation_repos: RepoTarget[];
}

/** Options for the command router functions. */
export interface CommandRouterOptions {
  /** Directory containing workflow `.md` files. */
  workflowsDir: string;
  /** Path to `agent-os/config.yml`. */
  configPath: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The set of valid workflow command names that the router intercepts. */
export const WORKFLOW_COMMANDS: ReadonlySet<WorkflowCommandName> =
  new Set<WorkflowCommandName>([
    "plan-product",
    "shape-spec",
    "write-spec",
    "create-tasks",
    "communicate-changes",
    "implement-tasks",
    "orchestrate-tasks",
  ]);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Determines whether `text` is a workflow command or a passthrough message.
 *
 * A workflow command starts with `/` followed by one of the 7 known names.
 * Anything after the command name (separated by whitespace) is captured as
 * `args`. All other input — including `/run`, plain text, or empty strings —
 * is returned as a passthrough.
 */
export function parseMessage(text: string): ParsedMessage {
  const trimmed = text.trim();

  if (!trimmed.startsWith("/")) {
    return { kind: "passthrough", text };
  }

  // Extract the command name: everything after `/` up to the first whitespace.
  const spaceIdx = trimmed.indexOf(" ");
  const rawCommand =
    spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

  if (WORKFLOW_COMMANDS.has(rawCommand as WorkflowCommandName)) {
    return {
      kind: "command",
      command: rawCommand as WorkflowCommandName,
      args,
    };
  }

  return { kind: "passthrough", text };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

/**
 * Reads and parses `agent-os/config.yml` into a typed {@link AgentOsConfig}.
 *
 * @throws If the file cannot be read or the YAML is malformed.
 */
export async function loadAgentOsConfig(
  configPath: string,
): Promise<AgentOsConfig> {
  const raw = await readFile(configPath, "utf-8");
  const parsed = parseYaml(raw);

  if (parsed == null || typeof parsed !== "object") {
    throw new Error(`Malformed config: expected an object at ${configPath}`);
  }

  return {
    version: String(parsed.version ?? ""),
    profile: String(parsed.profile ?? ""),
    use_claude_code_subagents: Boolean(parsed.use_claude_code_subagents),
    implementation_repos: Array.isArray(parsed.implementation_repos)
      ? parsed.implementation_repos
      : [],
  };
}

// ---------------------------------------------------------------------------
// Workflow loading
// ---------------------------------------------------------------------------

/**
 * Reads a workflow markdown file from the workflows directory.
 *
 * @param workflowsDir - Path to the `workflows/` directory.
 * @param name - The workflow command name (e.g. `"shape-spec"`).
 * @returns The raw markdown content of the workflow file.
 * @throws If the file does not exist or cannot be read.
 */
export async function loadWorkflow(
  workflowsDir: string,
  name: WorkflowCommandName,
): Promise<string> {
  const filePath = join(workflowsDir, `${name}.md`);
  return readFile(filePath, "utf-8");
}

// ---------------------------------------------------------------------------
// Conditional processing
// ---------------------------------------------------------------------------

/**
 * Processes `{{IF flag}}` / `{{ENDIF flag}}` and `{{UNLESS flag}}` /
 * `{{ENDUNLESS flag}}` template blocks in workflow markdown.
 *
 * When a flag is **true**:
 *   - `{{IF flag}}` blocks are **kept** (delimiters removed).
 *   - `{{UNLESS flag}}` blocks are **stripped**.
 *
 * When a flag is **false**:
 *   - `{{IF flag}}` blocks are **stripped**.
 *   - `{{UNLESS flag}}` blocks are **kept** (delimiters removed).
 *
 * Unknown flags default to `false`.
 */
export function processConditionals(
  md: string,
  flags: Record<string, boolean>,
): string {
  let result = md;

  // Process {{IF flag}} ... {{ENDIF flag}}
  result = result.replace(
    /\{\{IF\s+(\w+)\}\}\n?([\s\S]*?)\{\{ENDIF\s+\1\}\}\n?/g,
    (_match, flag: string, content: string) => {
      return flags[flag] ? content : "";
    },
  );

  // Process {{UNLESS flag}} ... {{ENDUNLESS flag}}
  result = result.replace(
    /\{\{UNLESS\s+(\w+)\}\}\n?([\s\S]*?)\{\{ENDUNLESS\s+\1\}\}\n?/g,
    (_match, flag: string, content: string) => {
      return flags[flag] ? "" : content;
    },
  );

  return result;
}

// ---------------------------------------------------------------------------
// Prompt expansion
// ---------------------------------------------------------------------------

/**
 * Builds a repo configuration markdown table from the config's
 * `implementation_repos` entries.
 */
function buildRepoTable(repos: RepoTarget[]): string {
  const header =
    "| Key | GitHub | Local | Branch Prefix | Test | Build |\n" +
    "|-----|--------|-------|---------------|------|-------|";

  const rows = repos.map(
    (r) =>
      `| ${r.key} | ${r.github} | ${r.local_path} | ${r.branch_prefix} | ${r.test_command ?? "—"} | ${r.build_command ?? "—"} |`,
  );

  return [header, ...rows].join("\n");
}

/** Context frame preamble prepended to every expanded prompt. */
const CONTEXT_FRAME = `\
You are executing an agent-os workflow via a messaging channel. Follow these rules:

1. **Execute inline**: When the workflow mentions "subagents", execute that work yourself inline — you cannot spawn Claude Code subagents from this session.
2. **Stop and wait**: When the workflow says "wait for user's response" or "WAIT for their response", stop output and wait for the user to reply via the channel.
3. **No auto-chaining**: Do NOT automatically run the next workflow when one completes. Inform the user and let them decide.
4. **Use repo config**: The repository configuration table below tells you where to find target repos, how to run tests and builds.`;

/**
 * Builds the full expanded prompt that replaces a short workflow command.
 *
 * @param workflowMd - The raw workflow markdown (after conditional processing).
 * @param config - The parsed agent-os config.
 * @param args - User-supplied arguments after the command name.
 * @param commandName - The workflow command that was invoked.
 * @returns A self-contained prompt string ready for `session.prompt()`.
 */
export function expandPrompt(
  workflowMd: string,
  config: AgentOsConfig,
  args: string,
  commandName: WorkflowCommandName,
): string {
  const repoTable = buildRepoTable(config.implementation_repos);

  const argsSection =
    args.length > 0
      ? `The user invoked: /${commandName} ${args}`
      : `The user invoked: /${commandName}`;

  return `## Workflow Context

${CONTEXT_FRAME}

### Repository Configuration

${repoTable}

### User's Request

${argsSection}

---

## Workflow: ${commandName}

${workflowMd}`;
}

// ---------------------------------------------------------------------------
// Unknown command help
// ---------------------------------------------------------------------------

/**
 * Returns a help message listing all available workflow commands.
 *
 * @param attempted - The command the user tried to invoke.
 */
export function unknownCommandMessage(attempted: string): string {
  const commandList = [...WORKFLOW_COMMANDS].map((c) => `  /${c}`).join("\n");

  return `Unknown command: /${attempted}

Available workflow commands:
${commandList}

Other messages are sent directly to the agent session.`;
}
