# AGENT.md

Operational contract for agents working in this spec/planning repo.

This is a **cross-repo workflow**: specs live here, implementation happens in external repos defined in `agent-os/config.yml`.

## 0) Definitions

- **PI Agent** (Plan/Investigate): Shapes specs, gathers requirements, writes specifications
- **Coding Assistant** (Implement): Clones target repo(s), implements tasks, creates PRs
- **Reviewer Agent**: Reviews PRs against spec acceptance criteria, validates correctness

## 1) Implementation Targets

Implementation repos are listed in `agent-os/config.yml` under `implementation_repos`. Each entry has:

| Field | Purpose |
|-------|---------|
| `key` | Short name used in specs and workflows |
| `github` | GitHub org/repo for `gh` CLI operations |
| `local_path` | Relative path for local clone |
| `branch_prefix` | Branch naming prefix (default: `spec/`) |
| `test_command` | How to run tests in that repo |
| `build_command` | How to verify compilation |

When a spec targets a specific repo, reference it by `key` in the spec's metadata.

## 2) Hard Constraints

### MUST

- Follow the agent-os workflow sequence: shape -> write -> tasks -> communicate -> implement
- Use `gh` CLI for cross-repo operations (clone, PR create, PR update)
- Create implementation branches from `main` in the target repo
- Reference the spec path in every PR body
- Read the target repo's `CLAUDE.md` before any implementation work
- Run the target repo's test suite before submitting PRs
- Track PR URLs in `specs/[this-spec]/implementation/pr.md`

### NEVER

- Implement directly in this specs repo (code goes in target repos)
- Skip the communicate-changes step (every spec needs a tracking PR)
- Modify deployment manifests in repos you don't own
- Skip running tests before pushing

## 3) Role Contracts

### PI Agent (Plan/Investigate)

**Primary goal**: Remove uncertainty before coding.

**Workflow**:
1. Run `/shape-spec` to initialize and scope a feature
2. Run `/write-spec` to create the formal specification
3. Run `/create-tasks` to break the spec into implementable tasks

**Output**: Spec folder with `spec.md`, `tasks.md`, `planning/requirements.md`

**Default behavior**:
- Prefer reading, researching, and planning
- Ask clarifying questions before making assumptions
- Do not write implementation code

### Coding Assistant (Implement)

**Primary goal**: Ship minimal, correct patches with proof.

**Workflow**:
1. Clone target repo: `gh repo clone [github] [local_path]`
2. Read target repo's `CLAUDE.md` for conventions
3. Create branch: `git checkout -b [branch_prefix][this-spec]`
4. Implement task groups from `specs/[this-spec]/tasks.md`
5. Run tests: `[test_command]` in target repo
6. Mark tasks complete: `[x]` in tasks.md
7. Push and update PR

**Output**:
- Files changed with rationale
- Validation commands run and results
- Updated tasks.md with completed items

### Reviewer Agent

**Primary goal**: Independently verify behavior and safety.

**Workflow**:
1. Read spec.md and tasks.md for acceptance criteria
2. Review PR diff in target repo
3. Run test suite to verify no regressions
4. Check implementation against spec requirements

**Output**:
- Findings by severity (critical/high/medium/low)
- Regression risks
- Required fixes before merge

## 4) Task State Machine

```
Discover -> Plan -> Communicate -> Implement -> Validate -> Land
```

1. **Discover**: Confirm scope, read existing spec materials
2. **Plan**: Shape spec, write requirements, create task list
3. **Communicate**: Create tracking PR in target repo (`/communicate-changes`)
4. **Implement**: Apply changes in target repo, following task groups
5. **Validate**: Run tests, verify acceptance criteria
6. **Land**: Push, update PR, mark tasks complete

Do not skip **Communicate**, **Validate**, or **Land**.

## 5) Cross-Repo Rules

| Rule | Details |
|------|---------|
| Branch naming | `[branch_prefix][this-spec]` in target repo |
| PR body | Must reference spec path in this specs repo |
| PR label | `spec-driven` |
| Task tracking | Update `specs/[this-spec]/tasks.md` after each task group |
| PR tracking | Store URL in `specs/[this-spec]/implementation/pr.md` |

## 6) Validation Matrix

| Change type | Minimum validation |
|---|---|
| TypeScript source | `[build_command]` then `[test_command]` |
| New module | `[test_command]` + import verification |
| API/interface changes | `[test_command]` + dependent module checks |
| Config/agent files | Manual review + dry run |

## 7) Multi-Agent Execution Rules

- One worktree per active agent in target repos
- Do not have two agents editing the same file concurrently
- Rebase before merge/push
- Keep handoffs explicit: summary + open risks + next actions

## 8) Output Contract (every agent update)

Always include:
1. **What changed** (files in target repo, tasks in specs repo)
2. **Commands run** (test, build, lint)
3. **Results** (pass/fail)
4. **Known risks / blockers**
5. **Next action**
