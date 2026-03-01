# Process for Orchestrating a Spec's Implementation

Now that we have a spec and tasks list ready for implementation, we will proceed with orchestrating implementation of each task group by a dedicated agent using the following MULTI-PHASE process.

> **Cross-repo context**: Read `agent-os/config.yml` to determine the target repo(s). Ensure they are cloned. Read each target repo's `CLAUDE.md` for build/test/deploy conventions. Create feature branches from `main`.

Follow each of these phases and their individual workflows IN SEQUENCE:

## Multi-Phase Process

### FIRST: Get tasks.md for this spec

IF you already know which spec we're working on and IF that spec folder has a `tasks.md` file, then use that and skip to the NEXT phase.

IF you don't already know which spec we're working on and IF that spec folder doesn't yet have a `tasks.md` THEN output the following request to the user:

```
Please point me to a spec's tasks.md that you want to orchestrate implementation for.

If you don't have one yet, then run any of these commands first:
/shape-spec
/write-spec
/create-tasks
```

### NEXT: Check for PR

Before proceeding with implementation, check if a PR has been created for this spec:
- Look for `specs/[this-spec]/implementation/pr.md`
- If it doesn't exist, inform the user: "No PR found for this spec. Run `/communicate-changes` first to create a tracking PR."

### NEXT: Create orchestration.yml to serve as a roadmap for orchestration of task groups

In this spec's folder, create this file: `specs/[this-spec]/orchestration.yml`.

Populate this file with the names of each task group found in this spec's `tasks.md` and use this EXACT structure for the content of `orchestration.yml`:

```yaml
target_repo: [key from agent-os/config.yml]
task_groups:
  - name: [task-group-name]
  - name: [task-group-name]
  - name: [task-group-name]
  # Repeat for each task group found in tasks.md
```

{{IF use_claude_code_subagents}}
### NEXT: Ask user to assign subagents to each task group

Next we must determine which subagents should be assigned to which task groups. Ask the user to provide this info using the following request to user and WAIT for user's response:

```
Please specify the name of each subagent to be assigned to each task group:

1. [task-group-name]
2. [task-group-name]
3. [task-group-name]
[repeat for each task-group you've added to orchestration.yml]

Simply respond with the subagent names and corresponding task group number and I'll update orchestration.yml accordingly.
```

Using the user's responses, update `orchestration.yml` to specify those subagent names. `orchestration.yml` should end up looking like this:

```yaml
target_repo: [key]
task_groups:
  - name: [task-group-name]
    claude_code_subagent: [subagent-name]
  - name: [task-group-name]
    claude_code_subagent: [subagent-name]
  - name: [task-group-name]
    claude_code_subagent: [subagent-name]
```

For example:

```yaml
target_repo: openclaw
task_groups:
  - name: channel-bridge-refactor
    claude_code_subagent: typescript-pro
  - name: fleet-memory-improvements
    claude_code_subagent: backend-architect
  - name: integration-tests
    claude_code_subagent: test-automator
```
{{ENDIF use_claude_code_subagents}}

{{IF use_claude_code_subagents}}
### NEXT: Delegate task groups implementations to assigned subagents

Read `agent-os/config.yml` to get the target repo details (github, local_path, test_command, build_command).

Loop through each task group in `specs/[this-spec]/tasks.md` and delegate its implementation to the assigned subagent specified in `orchestration.yml`.

For each delegation, provide the subagent with:
- The task group (including the parent task and all sub-tasks)
- The spec file: `specs/[this-spec]/spec.md`
- The target repo details from `agent-os/config.yml`
- Instruct subagent to:
  - Work in the target repo (clone if needed: `gh repo clone [github] [local_path]`)
  - Read target repo's `CLAUDE.md` for conventions
  - Perform their implementation
  - Run `[test_command]` and `[build_command]` to verify
  - Check off the task and sub-task(s) in `specs/[this-spec]/tasks.md`
{{ENDIF use_claude_code_subagents}}

{{UNLESS use_claude_code_subagents}}
### NEXT: Generate prompts

Now we must generate an ordered series of prompt texts, which will be used to direct the implementation of each task group listed in `orchestration.yml`.

Follow these steps to generate this spec's ordered series of prompts texts, each in its own .md file located in `specs/[this-spec]/implementation/prompts/`.

LOOP through EACH task group in `specs/[this-spec]/tasks.md` and for each, use the following workflow to generate a markdown file with prompt text for each task group:

#### Step 1. Create the prompt markdown file

Create the prompt markdown file using this naming convention:
`specs/[this-spec]/implementation/prompts/[task-group-number]-[task-group-title].md`.

#### Step 2. Populate the prompt file

Populate the prompt markdown file using the following template.

Read `agent-os/config.yml` to fill in repo details.

```markdown
We're continuing our implementation of [spec-title] by implementing task group number [task-group-number]:

## Implement this task and its sub-tasks:

[paste entire task group including parent task, all of its sub-tasks, and sub-bullet points]

## Understand the context

Read @specs/[this-spec]/spec.md to understand the context for this spec and where the current task fits into it.

Also read these further context and reference:
- @specs/[this-spec]/planning/requirements.md
- @specs/[this-spec]/planning/visuals

## Perform the implementation

Clone and work in the target repo if not already available:
`gh repo clone [github] [local_path]`

Read target repo's `CLAUDE.md` for build/test/deploy conventions.

Implement the task group, run [test_command] and [build_command] to verify, then mark tasks complete.
```

### Step 3: Output the list of created prompt files

Output to user the following:

```
Ready to begin implementation of [spec-title]!

Use the following list of prompts to direct the implementation of each task group:

[list prompt files in order]

Input those prompts into this chat one-by-one or queue them to run in order.

Progress will be tracked in specs/[this-spec]/tasks.md
```
{{ENDUNLESS use_claude_code_subagents}}
