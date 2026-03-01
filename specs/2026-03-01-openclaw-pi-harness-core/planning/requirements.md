# Requirements — OpenClaw Pi Harness Core

## Introduction

The OpenClaw Pi Harness extension connects messaging channels (Telegram, Slack, etc.) to Pi coding agent sessions, enabling users to control a fleet of AI coding workers through conversational interfaces. It is the integration layer between the OpenClaw messaging gateway and the Pi agent SDK.

The extension currently provides four core modules: session embedding, bidirectional channel bridging, fleet memory persistence, and run lifecycle formatting. This spec captures the existing implementation as a baseline and defines the requirements for the next iteration.

## Alignment with Product Vision

OpenClaw's vision is to make AI-powered software development accessible from any messaging platform. This extension is the backend engine that:
- Creates and manages Pi agent sessions programmatically
- Bridges real-time agent events to messaging channels (and user messages back to agents)
- Persists cross-worker knowledge so parallel workers can coordinate
- Formats run lifecycle events into scannable messages for mobile screens

## Requirements

### Requirement 1: Pi Session Embedding

**User Story:** As an OpenClaw operator, I want to programmatically create Pi agent sessions with extensions loaded, so that the messaging gateway can run AI agents without a local terminal.

#### Acceptance Criteria

1. WHEN `createHarnessSession(config)` is called THEN the system SHALL dynamically import `@mariozechner/pi-coding-agent` and create an `AgentSession` with the specified workspace and extensions
2. IF the peer dependency is not installed THEN the system SHALL throw a descriptive error with installation instructions
3. WHEN `runHarnessAgent(session, prompt, callbacks)` is called THEN the system SHALL subscribe to session events, send the prompt, relay events to callbacks, and return the full response text
4. WHEN `subscribeToSession(session, handlers)` is called THEN the system SHALL map Pi SDK events (`agent_start`, `agent_end`, `message_update`, `tool_execution_start`, `tool_execution_end`) to the `SessionEventHandlers` interface
5. IF a handler throws an error THEN the system SHALL catch it and route it to `onError` without crashing the listener
6. WHEN `disposeHarnessSession(session)` is called THEN the system SHALL call `dispose()` on the underlying Pi session

### Requirement 2: Bidirectional Channel Bridge

**User Story:** As a messaging app user, I want to send messages to an AI agent and receive its responses in the same chat, so that I can control coding work from my phone.

#### Acceptance Criteria

1. WHEN `bridgeSessionToChannel(session, channel)` is called THEN the system SHALL subscribe to Pi session events and buffer text deltas until `agent_end`, then send the full text as one channel message
2. IF `BridgeOptions.notifyOnToolStart` is `true` THEN the system SHALL send a `[tool] {name} started` notification on each `tool_execution_start` event
3. WHEN `bridgeChannelToSession(channel, session)` is called THEN the system SHALL register an `onMessage` handler that calls `session.prompt(text)` for each incoming message
4. IF the channel message includes images AND the session supports `promptWithImages` THEN the system SHALL call `promptWithImages(text, images)` instead of `prompt(text)`
5. IF the session does not support `promptWithImages` THEN the system SHALL append image URLs as `[image N]: url` text references and call `prompt(text)`
6. WHEN `sendMessage` fails THEN the system SHALL catch the error and log it without propagating to the session

### Requirement 3: RunMessage Formatting

**User Story:** As a messaging app user, I want to see structured, scannable updates about the run lifecycle (dispatches, merges, errors, completion), so that I can follow progress on a small screen.

#### Acceptance Criteria

1. WHEN `isRunMessage(value)` is called with a valid RunMessage object THEN the system SHALL return `true`
2. IF the `customType` is not one of the 7 valid types (`run-merge`, `run-dispatch`, `run-status`, `run-complete`, `run-error`, `run-stopped`, `run-cleanup`) THEN `isRunMessage` SHALL return `false`
3. WHEN `formatRunMessageForChannel(message)` is called THEN the system SHALL return a string with the appropriate prefix bracket (`[merge]`, `[dispatch]`, `[status]`, `[complete]`, `[error]`, `[stopped]`, `[cleanup]`) followed by the content
4. WHEN `bridgeRunMessageToChannel(message, channel)` is called THEN the system SHALL format the message and send it to the channel, catching and logging any errors

### Requirement 4: Fleet Memory

**User Story:** As an operator running parallel workers, I want completed worker results to be persisted and queryable, so that subsequent workers can leverage decisions and patterns from earlier workers.

#### Acceptance Criteria

1. WHEN `configureFleetMemory(config)` is called with an endpoint THEN the system SHALL probe connectivity (5s timeout) and set `available: true` if reachable
2. IF no endpoint is provided OR the probe fails THEN the system SHALL set `available: false` and `endpoint: null` with a console warning
3. WHEN `configureFleetMemory` runs THEN the system SHALL create the parent directory of `fallbackPath` recursively
4. WHEN `storeWorkerResult(taskName, result, config)` is called AND Graphiti is available THEN the system SHALL POST the result as an episode to Graphiti AND write to the local fallback file
5. IF the Graphiti POST fails THEN the system SHALL log a warning and still write to the local fallback file
6. WHEN `queryFleetContext(description, config)` is called AND Graphiti is available THEN the system SHALL POST a search query and return the mapped results as a `FleetContext`
7. IF Graphiti is unavailable THEN the system SHALL search the local `.memory.json` file using substring matching and return matching entries as `FleetContext`
8. IF any error occurs during query THEN the system SHALL return an empty `FleetContext` without throwing

### Requirement 5: Agent Configuration

**User Story:** As an operator, I want to configure the harness agent through a JSON config file, so that extension paths, worker limits, heartbeat settings, and Graphiti endpoints can be changed without code modification.

#### Acceptance Criteria

1. WHEN `agents/pi-harness/agent.json` is loaded THEN it SHALL specify the `simple-harness.ts`, `heartbeat.ts`, and `graphiti.ts` extensions
2. WHEN `HarnessAgentConfig` is used THEN it SHALL include `workspace`, `extensions[]`, `heartbeat` settings, `harness` settings (maxWorkers, staggerMs, tmuxServer), and optional `graphiti` settings

## Non-Functional Requirements

### Code Architecture and Modularity
- **Single Responsibility**: Each source file handles one concern (types, session, bridge, memory)
- **Peer Dependency Isolation**: Pi SDK imported dynamically; types imported with `import type`
- **Channel Abstraction**: All channel I/O goes through the `OpenClawChannel` interface
- **Error Boundaries**: Channel and Graphiti errors are caught at boundaries, never propagate

### Performance
- Text deltas buffered in memory and flushed once per agent turn (not per delta)
- Graphiti connectivity probed once at startup, not per operation
- Local memory file read/written atomically with JSON.parse/stringify

### Security
- No secrets stored in source; Graphiti endpoint and credentials passed via config
- `OpenClawChannel` interface does not expose raw transport details

### Reliability
- Fleet memory always writes locally regardless of Graphiti availability
- Session subscription errors caught and routed to `onError`
- Channel bridge errors logged but never crash the session
- `queryFleetContext` never throws; worst case returns empty context

### Testing
- 126 tests across 6 test files (unit + integration)
- All modules testable with mock sessions and channels
- Integration tests verify cross-module interactions (session <-> bridge <-> memory)
