/**
 * Shared TypeScript interfaces for the OpenClaw Pi Harness Extension.
 *
 * Types here are OpenClaw-specific. All worker/queue/registry/manager types
 * previously duplicated from pi-agent-extensions have been removed — the
 * simple-harness extension handles those internally.
 */

// ---------------------------------------------------------------------------
// RunMessage types (from simple-harness customType messages)
// ---------------------------------------------------------------------------

/**
 * Union of `customType` values emitted by simple-harness.ts via
 * `pi.sendMessage()`. Each value corresponds to a distinct lifecycle event
 * in the run pipeline.
 */
export type RunMessageType =
  | 'run-merge'
  | 'run-dispatch'
  | 'run-status'
  | 'run-complete'
  | 'run-error'
  | 'run-stopped'
  | 'run-cleanup';

/**
 * Shape of a message emitted by simple-harness via `pi.sendMessage()`.
 * The `customType` discriminant identifies the event kind; `content` carries
 * a human-readable description; `display` controls whether Pi's TUI renders
 * the message inline.
 */
export interface RunMessage {
  customType: RunMessageType;
  content: string;
  display: boolean;
}

// ---------------------------------------------------------------------------
// OpenClaw-Specific Types
// ---------------------------------------------------------------------------

export interface HarnessAgentConfig {
  workspace: string;
  extensions: string[];
  heartbeat: {
    enabled: boolean;
    intervalMs: number;
  };
  harness: {
    maxWorkers: number;
    staggerMs: number;
    tmuxServer: string;
  };
  graphiti?: {
    endpoint: string;
    groupId: string;
  };
}

export interface FleetMemoryConfig {
  endpoint: string | null;
  groupId: string;
  fallbackPath: string;
  available: boolean;
}

export interface FleetContext {
  entities: Array<{ name: string; type: string; summary: string }>;
  facts: Array<{ subject: string; predicate: string; object: string }>;
  patterns: string[];
}

export interface WorkerResult {
  taskName: string;
  filesModified: string[];
  filesCreated: string[];
  decisions: string[];
  patterns: string[];
}

// ---------------------------------------------------------------------------
// Session Event Handlers (for channel bridge)
// ---------------------------------------------------------------------------

export interface SessionEventHandlers {
  onAgentStart?: () => void;
  onTextDelta?: (delta: string) => void;
  onToolStart?: (toolName: string) => void;
  onToolEnd?: (toolName: string, result: string) => void;
  onAgentEnd?: (fullText: string) => void;
  onError?: (error: Error) => void;
}

// ---------------------------------------------------------------------------
// Channel abstraction (for OpenClaw gateway bridge)
// ---------------------------------------------------------------------------

export interface OpenClawChannel {
  sendMessage(text: string): Promise<void>;
  sendImage?(url: string, caption?: string): Promise<void>;
  onMessage(handler: (text: string, images?: string[]) => void): void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Path to the local fleet memory file within the .run/ directory. */
export const MEMORY_FILE_PATH = '.run/.memory.json';
