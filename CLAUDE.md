# CLAUDE.md — openclaw-pi-harness

Specification and planning repository for the OpenClaw Pi Harness extension.
Agents use this repo to plan, spec, and drive implementation across target repos.

## How This Repo Works

This repo follows the **agent-os** workflow framework:

1. `/agent-os:plan-product` — Product vision, roadmap, tech stack
2. `/agent-os:shape-spec` — Initialize and scope a new feature
3. `/agent-os:write-spec` — Write formal specification
4. `/agent-os:create-tasks` — Break spec into implementable tasks
5. `/agent-os:communicate-changes` — Create PR in target repo(s)
6. `/agent-os:implement-tasks` — Implement tasks (simple mode)
7. `/agent-os:orchestrate-tasks` — Implement tasks (multi-agent mode)

## Implementation Targets

All implementation happens in external repos listed in `agent-os/config.yml`.
When running implementation workflows:

1. Check `agent-os/config.yml` for the target repo's `github` and `local_path`
2. Clone if not available: `gh repo clone [github] [local_path]`
3. Read the target repo's `CLAUDE.md` for build/test/deploy conventions
4. Create feature branches from `main`
5. Submit PRs back to the target repo

### Current Targets

| Key | Repo | Description |
|-----|------|-------------|
| `openclaw` | `zach-source/openclaw-pi-harness` | OpenClaw extension (TypeScript) |
| `pi-extensions` | `zach-source/pi-agent-extensions` | Pi agent extensions |

## Directory Layout

| Path | Purpose |
|------|---------|
| `agent-os/` | Agent-OS configuration |
| `.claude/commands/agent-os/` | Claude Code slash commands |
| `workflows/` | Workflow definitions (reference docs) |
| `templates/` | Document templates for specs |
| `specs/` | Feature specifications |
| `plans/` | Implementation plans |
| `backlog/` | Task backlog items |
| `agents/` | Agent configs (pi-harness) |
| `src/` | Extension source (also an implementation target) |
| `test/` | Extension tests |

## Conventions

- Spec directories: `YYYY-MM-DD-feature-name/`
- Each spec has: `spec.md`, `tasks.md`, `planning/requirements.md`
- Completed tasks marked `[x]` in tasks.md
- PRs tracked in `specs/[name]/implementation/pr.md`
- Implementation branches: `spec/[this-spec]` in target repo

## Build & Test (Local Extension)

```bash
npx tsc --noEmit          # Type check
npx vitest run            # Run all tests
npx prettier --check .    # Format check
```

## Key References

- **Agent contract**: `AGENT.md` — roles, constraints, workflows
- **Config**: `agent-os/config.yml` — repo targets, settings
- **Commands**: `.claude/commands/agent-os/` — Claude Code slash commands
- **Workflows**: `workflows/` — workflow reference documentation
