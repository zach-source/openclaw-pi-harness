# Communicate Changes Process

After a spec has been shaped, written, and broken into tasks, this workflow creates a tracking PR in the target implementation repo that communicates the planned changes and provides a feedback loop.

This workflow fits between task creation and implementation:

```
shape-spec -> write-spec -> create-tasks -> **communicate-changes** -> implement-tasks
```

Follow each phase IN SEQUENCE:

## Multi-Phase Process

### PHASE 1: Read spec, tasks, and config

Load the spec and task list for the current feature:
- `specs/[this-spec]/spec.md`
- `specs/[this-spec]/tasks.md`

IF either file is missing, inform the user:

```
I need both spec.md and tasks.md to communicate changes.

Missing: [list missing files]

Run /agent-os:write-spec and/or /agent-os:create-tasks first.
```

Extract from the spec:
- **Title**: the spec name / feature title
- **Summary**: 2-3 sentence overview from the spec introduction
- **Acceptance criteria**: from the spec or requirements
- **Task groups**: the full task list with checkboxes

Read `agent-os/config.yml` to determine the target implementation repo(s). If the spec targets a specific repo, use that one. If ambiguous, ask the user which target repo to use.

### PHASE 2: Clone target repo and create branch

For each target repo (from `agent-os/config.yml`):

```bash
# Clone if not already present
if [ ! -d "[local_path]" ]; then
  gh repo clone [github] [local_path]
fi
cd [local_path]
```

Create a feature branch from `main`:

```bash
git checkout main
git pull origin main
git checkout -b [branch_prefix][this-spec]
```

Where `[this-spec]` is the spec directory name (e.g., `2026-03-01-channel-improvements`).

### PHASE 3: Create PR in target repo

Push the branch and create a PR using `gh`:

```bash
git commit --allow-empty -m "feat: begin [branch_prefix][this-spec] implementation"
git push -u origin [branch_prefix][this-spec]
```

Create the PR with structured body:

```bash
gh pr create \
  --title "[spec-title]" \
  --label "spec-driven" \
  --body "$(cat <<'EOF'
## Summary

[2-3 sentence summary from spec.md]

## Spec Reference

- Spec repo: [this specs repo github path]
- Spec: `specs/[this-spec]/spec.md`
- Tasks: `specs/[this-spec]/tasks.md`

## Task List

[paste full task list from tasks.md with checkboxes]

## Acceptance Criteria

[paste acceptance criteria from spec or requirements]

---

*This PR was created by the communicate-changes workflow.*
EOF
)"
```

### PHASE 4: Track PR

Record the PR URL in the specs repo for future reference:

```bash
mkdir -p specs/[this-spec]/implementation
echo "PR: [pr-url]" > specs/[this-spec]/implementation/pr.md
echo "Target: [github]" >> specs/[this-spec]/implementation/pr.md
echo "Branch: [branch_prefix][this-spec]" >> specs/[this-spec]/implementation/pr.md
echo "Created: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> specs/[this-spec]/implementation/pr.md
```

Commit the tracking file:

```bash
git add specs/[this-spec]/implementation/pr.md
git commit -m "track: add PR reference for [this-spec]"
git push
```

### PHASE 5: Inform user

Output the following:

```
PR created and tracked!

Branch: [branch_prefix][this-spec] in [github]
PR: [pr-url]
Tracking: specs/[this-spec]/implementation/pr.md

The PR communicates the planned changes and will track implementation progress.
As tasks are completed, update the task checkboxes in tasks.md and the PR body.

NEXT STEP: Run /agent-os:implement-tasks (simple) or /agent-os:orchestrate-tasks (advanced) to start building!
```

### Post-Implementation: Update PR

After `/agent-os:implement-tasks` or `/agent-os:orchestrate-tasks` completes all tasks:

1. Update the PR body in target repo to reflect completed tasks (all `[x]`)
2. Add a comment summarizing what was implemented
3. Request review if configured
4. Mark `specs/[this-spec]/tasks.md` tasks as `[x]` in the specs repo
