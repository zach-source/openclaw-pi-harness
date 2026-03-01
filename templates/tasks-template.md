# Tasks Document

Tasks are organized into strategic groups. Each group represents a coherent unit of work that can be assigned to a subagent. Tasks within a group are ordered by dependency.

## Format

```markdown
- [ ] 1. Task Group: [Group Name]
  - [ ] 1.1 [Subtask description]
    - File: [target file path]
    - Purpose: [why this subtask exists]
    - _Leverage: [existing code to build upon]_
    - _Requirements: [requirement IDs from spec]_
  - [ ] 1.2 [Subtask description]
    - File: [target file path]
    - Purpose: [why this subtask exists]
    - _Leverage: [existing code to build upon]_
    - _Requirements: [requirement IDs from spec]_

- [ ] 2. Task Group: [Group Name]
  - [ ] 2.1 [Subtask description]
    ...
```

## Status Markers

- `[ ]` — Pending
- `[-]` — In progress
- `[x]` — Completed

## Guidelines

- Each task group should be implementable independently (or with clearly stated dependencies)
- List files to create or modify for each subtask
- Reference requirement IDs from the spec
- Note existing code to leverage (avoid reimplementation)
- Order subtasks by dependency within each group
