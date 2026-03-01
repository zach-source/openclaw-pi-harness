# Pi Harness Agent — Tools Reference

## Pi Built-in Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents from the filesystem |
| `write` | Write content to a file, creating it if it does not exist |
| `edit` | Apply targeted edits to an existing file via string replacement |
| `bash` | Execute shell commands and return output |

## Simple Harness Commands

| Command | Description |
|---------|-------------|
| `/run [objective]` | Start a run: generate tasks from the objective, spawn workers, auto-merge results |
| `/run:status` | Show progress summary of all workers and tasks |
| `/run:stop` | Stop all workers gracefully and preserve state |
| `/run:cleanup` | Remove all worktrees, branches, and run state |

## Simple Harness Tools

| Tool | Description |
|------|-------------|
| `run_plan` | Submit a structured task plan for execution (array of tasks with goals, roles, dependencies) |
| `run_status` | Show progress of all workers programmatically |
| `run_update_goal` | Add, complete, or remove goals on a specific worker |

## Heartbeat Tools

| Tool | Description |
|------|-------------|
| `heartbeat_complete` | Signal task completion and report final status to the heartbeat service |
| `heartbeat_new_session` | Register a new working session with the heartbeat monitor |
| `heartbeat_context` | Update the current session context sent with heartbeat pings |
