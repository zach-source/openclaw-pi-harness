# Spec: OpenClaw Pi Harness Core

**Status**: Baseline (documenting existing implementation)
**Target repo**: `openclaw` (zach-source/openclaw-pi-harness)
**Created**: 2026-03-01

## Goal

Establish a specification baseline for the OpenClaw Pi Harness extension — the TypeScript integration layer that connects messaging channels to Pi coding agent sessions. This spec documents the four core modules as implemented, validates the current architecture, and identifies areas for future improvement.

## User Stories

1. **Operator creates a session**: An OpenClaw operator programmatically creates a Pi agent session with extensions loaded, runs prompts against it, and receives structured callbacks during execution.

2. **User chats with an agent**: A messaging app user sends text (and optionally images) to a channel. The message is forwarded to the Pi session as a prompt. When the agent responds, the full text is sent back to the channel as a single message.

3. **User monitors a run**: During a `/run` execution, the simple-harness emits RunMessages (dispatch, merge, status, error, complete, stopped, cleanup). Each is formatted with a bracket prefix and delivered to the channel for scannable progress updates.

4. **Workers share knowledge**: When a worker completes a task, its results (files changed, decisions, patterns) are persisted to Graphiti and a local fallback. Subsequent workers query this fleet memory to leverage prior decisions without direct communication.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                       │
│  (Telegram / Slack / custom messaging)                    │
└──────────────┬───────────────────────────┬───────────────┘
               │ OpenClawChannel           │ OpenClawChannel
               ▼                           ▼
┌──────────────────────────┐  ┌──────────────────────────┐
│   bridgeChannelToSession │  │ bridgeSessionToChannel   │
│   (user msg → prompt)    │  │ (agent events → channel) │
└──────────────┬───────────┘  └───────────────┬──────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────────────────────────────────────┐
│                    Pi Session Embedder                    │
│  createHarnessSession() → runHarnessAgent() → dispose()  │
│  subscribeToSession() maps SDK events to handlers        │
└──────────────────────────┬───────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              ▼                         ▼
┌─────────────────────┐  ┌──────────────────────────────┐
│  simple-harness.ts  │  │       Fleet Memory           │
│  (Pi extension)     │  │  configureFleetMemory()      │
│  /run, run_plan     │  │  storeWorkerResult()         │
│  RunMessages        │  │  queryFleetContext()          │
└─────────────────────┘  │  Graphiti + local .json       │
                         └──────────────────────────────┘
```

## Specific Requirements

### Module 1: Types (`src/types.ts`)

| Type | Purpose |
|------|---------|
| `RunMessageType` | Union of 7 valid `customType` values from simple-harness |
| `RunMessage` | `{ customType, content, display }` — structured harness event |
| `HarnessAgentConfig` | Session creation config (workspace, extensions, heartbeat, harness, graphiti) |
| `FleetMemoryConfig` | Memory subsystem config (endpoint, groupId, fallbackPath, available) |
| `FleetContext` | Query result (entities, facts, patterns) |
| `WorkerResult` | Worker output (taskName, files, decisions, patterns) |
| `SessionEventHandlers` | Callback interface for session events |
| `OpenClawChannel` | Channel abstraction (`sendMessage`, `onMessage`, optional `sendImage`) |
| `MEMORY_FILE_PATH` | Constant: `.run/.memory.json` |

### Module 2: Pi Session (`src/pi-session.ts`)

| Function | Signature | Behavior |
|----------|-----------|----------|
| `createHarnessSession` | `(config) → Promise<HarnessSession>` | Dynamic import Pi SDK, create session with extensions |
| `runHarnessAgent` | `(session, prompt, callbacks?) → Promise<string>` | Subscribe, prompt, relay events, return text |
| `subscribeToSession` | `(session, handlers) → () => void` | Map SDK events to `SessionEventHandlers`, return unsubscribe |
| `disposeHarnessSession` | `(session) → void` | Call `dispose()` on underlying session |
| `isHarnessSession` | `(value) → value is HarnessSession` | Type guard for session shape |

### Module 3: Channel Bridge (`src/channel-bridge.ts`)

| Function | Signature | Behavior |
|----------|-----------|----------|
| `bridgeSessionToChannel` | `(session, channel, options?) → () => void` | Buffer deltas, flush on agent_end, optional tool notifications |
| `bridgeChannelToSession` | `(channel, session) → void` | Route channel messages to session.prompt, handle images |
| `isRunMessage` | `(value) → value is RunMessage` | Type guard for 7 valid customTypes |
| `formatRunMessageForChannel` | `(message) → string` | Prefix bracket + content |
| `bridgeRunMessageToChannel` | `(message, channel) → Promise<void>` | Format + send, catch errors |

### Module 4: Fleet Memory (`src/fleet-memory.ts`)

| Function | Signature | Behavior |
|----------|-----------|----------|
| `configureFleetMemory` | `(config) → Promise<FleetMemoryConfig>` | Probe Graphiti, create dirs, return config |
| `storeWorkerResult` | `(taskName, result, config) → Promise<void>` | POST to Graphiti + always write local |
| `queryFleetContext` | `(description, config) → Promise<FleetContext>` | Search Graphiti or local file, never throws |

## Design Patterns

- **Peer dependency isolation**: Pi SDK loaded via `dynamic import()` at runtime; types via `import type` (erased at compile time)
- **Error boundaries**: Every external call (channel, Graphiti, SDK) is wrapped in try/catch at the boundary
- **Dual-write memory**: Graphiti is best-effort; local JSON is always-write
- **Buffer-and-flush**: Text deltas accumulated per agent turn, sent as single message
- **Handler map subscribe**: `bridgeSessionToChannel` passes `{ agent_start: fn, ... }` to session.subscribe
- **Listener function subscribe**: `subscribeToSession` passes a single event listener function

## Out of Scope

- Channel-specific adapters (Telegram, Slack) — those live in the OpenClaw gateway
- Simple-harness internals (worker spawning, tmux, git worktrees) — lives in pi-agent-extensions
- Deployment and infrastructure — handled externally
- Authentication and authorization for channels

## Existing Code to Leverage

| File | What it provides |
|------|-----------------|
| `src/types.ts` | All shared interfaces and constants |
| `src/pi-session.ts` | Session creation, event subscription, disposal |
| `src/channel-bridge.ts` | Bidirectional bridging, RunMessage formatting |
| `src/fleet-memory.ts` | Graphiti + local fallback memory |
| `agents/pi-harness/agent.json` | Extension configuration |
| 126 tests across 6 files | Comprehensive unit + integration coverage |

## Future Considerations

1. **Channel adapters**: First-party Telegram and Slack channel implementations
2. **Rich formatting**: Markdown or structured message formatting per platform
3. **Run progress tracking**: Persistent run state with resume capability
4. **Multi-session management**: Multiple concurrent sessions per channel
5. **Webhook integration**: Incoming webhooks for CI/CD event bridging
6. **Image generation bridging**: Forward agent-generated images to channel via `sendImage`
