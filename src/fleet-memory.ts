/**
 * Fleet Memory — Graphiti integration with local fallback.
 *
 * Provides three public functions that the OpenClaw harness uses to persist
 * and retrieve cross-worker knowledge:
 *
 *   - {@link configureFleetMemory} — probe connectivity and build a config object
 *   - {@link storeWorkerResult}    — write a completed task result to memory
 *   - {@link queryFleetContext}    — retrieve relevant context for a new task
 *
 * When Graphiti is unreachable (or no endpoint is configured) every operation
 * falls back to a local `.memory.json` file so the harness never blocks on
 * network availability.
 */

import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

import type { FleetContext, FleetMemoryConfig, WorkerResult } from './types.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A single entry persisted in the local `.memory.json` fallback file. */
interface LocalMemoryEntry {
  id: string;
  taskName: string;
  timestamp: string;
  filesModified: string[];
  filesCreated: string[];
  decisions: string[];
  patterns: string[];
}

/** Shape of the Graphiti search response we expect. */
interface GraphitiSearchResponse {
  entities?: Array<{ name?: string; entity_type?: string; summary?: string }>;
  facts?: Array<{
    subject?: string;
    predicate?: string;
    object?: string;
  }>;
  patterns?: string[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Timeout in milliseconds for the Graphiti connectivity probe. */
const CONNECTIVITY_PROBE_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Attempt a GET request to `url` and return `true` if we receive any HTTP
 * response within the allotted timeout. Network errors or a timed-out request
 * both return `false`.
 */
async function probeEndpoint(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    CONNECTIVITY_PROBE_TIMEOUT_MS,
  );

  try {
    await fetch(url, { method: 'GET', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read and parse the local memory file. Returns an empty array when the file
 * does not exist or contains invalid JSON — never throws.
 */
async function readLocalMemory(
  fallbackPath: string,
): Promise<LocalMemoryEntry[]> {
  try {
    const raw = await readFile(fallbackPath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalMemoryEntry[]) : [];
  } catch {
    return [];
  }
}

/**
 * Atomically append `entry` to the local memory JSON array.
 *
 * We read the existing file first so that concurrent writers lose at most the
 * last entry rather than the entire history. The parent directory is assumed to
 * already exist (guaranteed by {@link configureFleetMemory}).
 */
async function appendLocalMemory(
  fallbackPath: string,
  entry: LocalMemoryEntry,
): Promise<void> {
  const entries = await readLocalMemory(fallbackPath);
  entries.push(entry);
  await writeFile(fallbackPath, JSON.stringify(entries, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Configure the fleet memory subsystem.
 *
 * If `endpoint` is provided the function probes it with a GET request (5 s
 * timeout). A successful probe sets `available: true` in the returned config.
 * Any connectivity failure, or omitting `endpoint` altogether, sets
 * `available: false` and `endpoint: null`.
 *
 * The parent directory of `fallbackPath` is created (recursively) so that
 * subsequent write operations can proceed without extra directory setup.
 *
 * @param config.endpoint    - Optional Graphiti base URL to probe.
 * @param config.groupId     - Graphiti group / namespace identifier.
 * @param config.fallbackPath - Absolute path to the local `.memory.json` file.
 * @returns A resolved {@link FleetMemoryConfig} ready for use by other functions.
 */
export async function configureFleetMemory(config: {
  endpoint?: string;
  groupId: string;
  fallbackPath: string;
}): Promise<FleetMemoryConfig> {
  const { endpoint, groupId, fallbackPath } = config;

  // Ensure the parent directory for the local fallback file exists.
  await mkdir(dirname(fallbackPath), { recursive: true });

  if (!endpoint) {
    console.warn(
      '[fleet-memory] No Graphiti endpoint configured — using local fallback only.',
    );
    return { endpoint: null, groupId, fallbackPath, available: false };
  }

  const reachable = await probeEndpoint(endpoint);

  if (!reachable) {
    console.warn(
      `[fleet-memory] Graphiti endpoint unreachable: ${endpoint} — using local fallback only.`,
    );
    return { endpoint: null, groupId, fallbackPath, available: false };
  }

  return { endpoint, groupId, fallbackPath, available: true };
}

/**
 * Persist a completed worker result to fleet memory.
 *
 * When Graphiti is available the result is POSTed as an episode. Regardless
 * of Graphiti availability the entry is **also** appended to the local
 * `.memory.json` fallback file so the history is never lost.
 *
 * Graphiti POST failures are logged as warnings and do **not** propagate —
 * the local write always runs even if the remote call fails.
 *
 * @param taskName - Human-readable name of the completed task.
 * @param result   - Structured output produced by the worker.
 * @param config   - Fleet memory config returned by {@link configureFleetMemory}.
 */
export async function storeWorkerResult(
  taskName: string,
  result: WorkerResult,
  config: FleetMemoryConfig,
): Promise<void> {
  const id = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const entry: LocalMemoryEntry = {
    id,
    taskName,
    timestamp,
    filesModified: result.filesModified,
    filesCreated: result.filesCreated,
    decisions: result.decisions,
    patterns: result.patterns,
  };

  // --- Graphiti (best-effort) ---
  if (config.available && config.endpoint !== null) {
    const episodeBody = {
      group_id: config.groupId,
      episode: {
        id,
        type: 'worker_result',
        task_name: taskName,
        timestamp,
        files_modified: result.filesModified,
        files_created: result.filesCreated,
        decisions: result.decisions,
        patterns: result.patterns,
      },
    };

    try {
      const response = await fetch(`${config.endpoint}/episodes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(episodeBody),
      });

      if (!response.ok) {
        console.warn(
          `[fleet-memory] Graphiti POST failed (HTTP ${response.status}) — falling back to local storage.`,
        );
      }
    } catch (err) {
      console.warn(
        '[fleet-memory] Graphiti POST threw an error — falling back to local storage.',
        err,
      );
    }
  }

  // --- Local fallback (always runs) ---
  await appendLocalMemory(config.fallbackPath, entry);
}

/**
 * Query fleet memory for context relevant to an upcoming task.
 *
 * When Graphiti is available the description is sent as a search query and the
 * response is mapped into a {@link FleetContext}. When Graphiti is unavailable
 * the local `.memory.json` file is scanned with simple substring matching
 * against the task description and the matching entries are assembled into a
 * {@link FleetContext}.
 *
 * This function **never throws** — any error at any stage results in an empty
 * {@link FleetContext} being returned.
 *
 * @param taskDescription - Natural-language description of the upcoming task.
 * @param config          - Fleet memory config returned by {@link configureFleetMemory}.
 * @returns Relevant entities, facts, and patterns from prior worker runs.
 */
export async function queryFleetContext(
  taskDescription: string,
  config: FleetMemoryConfig,
): Promise<FleetContext> {
  const empty: FleetContext = { entities: [], facts: [], patterns: [] };

  // --- Graphiti path ---
  if (config.available && config.endpoint !== null) {
    try {
      const response = await fetch(`${config.endpoint}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          group_id: config.groupId,
          query: taskDescription,
        }),
      });

      if (!response.ok) {
        console.warn(
          `[fleet-memory] Graphiti search failed (HTTP ${response.status}) — returning empty context.`,
        );
        return empty;
      }

      const raw: unknown = await response.json();
      const data = raw as GraphitiSearchResponse;

      return {
        entities: (data.entities ?? []).map((e) => ({
          name: e.name ?? '',
          type: e.entity_type ?? '',
          summary: e.summary ?? '',
        })),
        facts: (data.facts ?? []).map((f) => ({
          subject: f.subject ?? '',
          predicate: f.predicate ?? '',
          object: f.object ?? '',
        })),
        patterns: data.patterns ?? [],
      };
    } catch (err) {
      console.warn(
        '[fleet-memory] Graphiti search threw an error — returning empty context.',
        err,
      );
      return empty;
    }
  }

  // --- Local fallback path ---
  try {
    const entries = await readLocalMemory(config.fallbackPath);

    if (entries.length === 0) {
      return empty;
    }

    const needle = taskDescription.toLowerCase();

    const matching = entries.filter((entry) => {
      const haystack = [
        entry.taskName,
        ...entry.decisions,
        ...entry.patterns,
        ...entry.filesModified,
        ...entry.filesCreated,
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(needle);
    });

    if (matching.length === 0) {
      return empty;
    }

    // Map local entries into a FleetContext:
    //   entities  — one per matching task (name = taskName, type = "task")
    //   facts     — each decision becomes a subject/predicate/object triple
    //   patterns  — deduplicated union of all pattern strings
    const entities = matching.map((e) => ({
      name: e.taskName,
      type: 'task',
      summary: `Modified: ${e.filesModified.join(', ') || 'none'}. Created: ${e.filesCreated.join(', ') || 'none'}.`,
    }));

    const facts = matching.flatMap((e) =>
      e.decisions.map((decision) => ({
        subject: e.taskName,
        predicate: 'decided',
        object: decision,
      })),
    );

    const patterns = [...new Set(matching.flatMap((e) => e.patterns))];

    return { entities, facts, patterns };
  } catch (err) {
    console.warn(
      '[fleet-memory] Local memory query failed — returning empty context.',
      err,
    );
    return empty;
  }
}
