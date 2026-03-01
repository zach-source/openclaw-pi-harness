# Raw Idea — OpenClaw Pi Harness Core

## Problem

AI coding agents (Pi) run in terminal sessions. To make them accessible from messaging platforms (Telegram, Slack), we need an integration layer that:

1. Creates and manages Pi sessions programmatically (no terminal required)
2. Bridges messages bidirectionally between channels and sessions
3. Formats run lifecycle events for mobile-friendly display
4. Enables parallel workers to share knowledge without direct communication

## Solution

The OpenClaw Pi Harness extension — a TypeScript library that:

- **Embeds Pi sessions** via dynamic import of the peer dependency
- **Bridges channels** bidirectionally (user messages -> prompts, agent responses -> channel messages)
- **Formats RunMessages** from simple-harness with prefix brackets for scannable mobile display
- **Persists fleet memory** to Graphiti (knowledge graph) with local JSON fallback

## Key Design Decisions

1. **Peer dependency**: Pi SDK is a peer dep loaded dynamically — the extension compiles without it
2. **Buffer-and-flush**: Text deltas are accumulated per turn, not streamed per-delta to channels
3. **Dual-write memory**: Graphiti is best-effort; local file is always-write
4. **Channel abstraction**: `OpenClawChannel` interface decouples from transport (Telegram, Slack, etc.)
5. **Simple-harness as driver**: Replaced custom orchestration with the battle-tested simple-harness extension

## Scope

This baseline spec documents the current v0.1.0 implementation. Future specs will add:
- Channel adapters (Telegram, Slack)
- Rich message formatting per platform
- Multi-session management
- Run state persistence and resume
