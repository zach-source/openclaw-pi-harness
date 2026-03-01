# Task List Creation Process

You are creating a tasks breakdown from a given spec and requirements for a new feature.

## PHASE 1: Get and read the spec.md and/or requirements document(s)

You will need ONE OR BOTH of these files to inform your tasks breakdown:
- `specs/[this-spec]/spec.md`
- `specs/[this-spec]/planning/requirements.md`

IF you don't have ONE OR BOTH of those files in your current conversation context, then ask user to provide direction on where to you can find them by outputting the following request then wait for user's response:

```
I'll need a spec.md or requirements.md (or both) in order to build a tasks list.

Please direct me to where I can find those. If you haven't created them yet, you can run /agent-os:shape-spec or /agent-os:write-spec.
```

## PHASE 2: Create tasks.md

Once you have `spec.md` AND/OR `requirements.md`, use the **tasks-list-creator** subagent to break down the spec and requirements into an actionable tasks list with strategic grouping and ordering.

Provide the tasks-list-creator:
- `specs/[this-spec]/spec.md` (if present)
- `specs/[this-spec]/planning/requirements.md` (if present)
- `specs/[this-spec]/planning/visuals/` and its contents (if present)

The tasks-list-creator will create `tasks.md` inside the spec folder.

## PHASE 3: Inform user

Once the tasks-list-creator has created `tasks.md` output the following to inform the user:

```
Your tasks list ready!

Tasks list created: specs/[this-spec]/tasks.md

NEXT STEP: Run /agent-os:communicate-changes to create a PR in the target repo, then /agent-os:implement-tasks (simple) or /agent-os:orchestrate-tasks (advanced) to start building!
```
