/**
 * Unit tests for fleet-memory.ts
 *
 * Tests cover:
 *   - configureFleetMemory without endpoint → available: false
 *   - configureFleetMemory with unreachable endpoint → available: false
 *   - storeWorkerResult writes to local .memory.json when Graphiti unavailable
 *   - queryFleetContext returns empty FleetContext when no memories exist
 *   - queryFleetContext returns matching results from local .memory.json
 */

import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  configureFleetMemory,
  queryFleetContext,
  storeWorkerResult,
} from '../src/fleet-memory.js';
import type { FleetMemoryConfig, WorkerResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a unique temp directory for each test to ensure isolation. */
async function makeTempDir(): Promise<string> {
  const dir = join(
    tmpdir(),
    `fleet-memory-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

function makeWorkerResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    taskName: 'default-task',
    filesModified: ['src/index.ts'],
    filesCreated: ['src/new-module.ts'],
    decisions: ['use-composition-over-inheritance'],
    patterns: ['repository-pattern'],
    ...overrides,
  };
}

function makeUnavailableConfig(fallbackPath: string): FleetMemoryConfig {
  return {
    endpoint: null,
    groupId: 'test-group',
    fallbackPath,
    available: false,
  };
}

// ---------------------------------------------------------------------------
// configureFleetMemory
// ---------------------------------------------------------------------------

describe('configureFleetMemory', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('returns available: false when no endpoint is provided', async () => {
    const fallbackPath = join(tempDir, 'sub', '.memory.json');

    const config = await configureFleetMemory({
      groupId: 'test-group',
      fallbackPath,
    });

    expect(config.available).toBe(false);
    expect(config.endpoint).toBeNull();
    expect(config.groupId).toBe('test-group');
    expect(config.fallbackPath).toBe(fallbackPath);
  });

  it('creates the parent directory for fallbackPath even when no endpoint is given', async () => {
    const fallbackPath = join(tempDir, 'nested', 'deep', '.memory.json');

    await configureFleetMemory({ groupId: 'g', fallbackPath });

    // The parent directory should exist even though we never wrote a file.
    const { stat } = await import('fs/promises');
    const info = await stat(join(tempDir, 'nested', 'deep'));
    expect(info.isDirectory()).toBe(true);
  });

  it('returns available: false when the endpoint is unreachable (fetch throws)', async () => {
    const fallbackPath = join(tempDir, '.memory.json');

    // Mock global fetch to simulate a network error.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    );

    const config = await configureFleetMemory({
      endpoint: 'http://localhost:9999',
      groupId: 'test-group',
      fallbackPath,
    });

    expect(config.available).toBe(false);
    expect(config.endpoint).toBeNull();

    vi.unstubAllGlobals();
  });

  it('returns available: true when the endpoint responds successfully', async () => {
    const fallbackPath = join(tempDir, '.memory.json');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200 }),
    );

    const config = await configureFleetMemory({
      endpoint: 'http://localhost:8000',
      groupId: 'test-group',
      fallbackPath,
    });

    expect(config.available).toBe(true);
    expect(config.endpoint).toBe('http://localhost:8000');

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// storeWorkerResult
// ---------------------------------------------------------------------------

describe('storeWorkerResult', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('writes the result to local .memory.json when Graphiti is unavailable', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);
    const result = makeWorkerResult({
      taskName: 'auth-api',
      decisions: ['jwt-over-sessions'],
    });

    await storeWorkerResult('auth-api', result, config);

    const raw = await readFile(fallbackPath, 'utf-8');
    const entries: unknown[] = JSON.parse(raw);

    expect(entries).toHaveLength(1);
    const entry = entries[0] as Record<string, unknown>;
    expect(entry['taskName']).toBe('auth-api');
    expect(entry['decisions']).toEqual(['jwt-over-sessions']);
    expect(typeof entry['id']).toBe('string');
    expect(typeof entry['timestamp']).toBe('string');
  });

  it('appends to existing .memory.json entries without losing prior data', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    await storeWorkerResult(
      'task-one',
      makeWorkerResult({ taskName: 'task-one' }),
      config,
    );
    await storeWorkerResult(
      'task-two',
      makeWorkerResult({ taskName: 'task-two' }),
      config,
    );

    const raw = await readFile(fallbackPath, 'utf-8');
    const entries: unknown[] = JSON.parse(raw);

    expect(entries).toHaveLength(2);
    const names = (entries as Array<Record<string, unknown>>).map(
      (e) => e['taskName'],
    );
    expect(names).toContain('task-one');
    expect(names).toContain('task-two');
  });

  it('persists filesModified, filesCreated, and patterns fields', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);
    const result = makeWorkerResult({
      taskName: 'db-task',
      filesModified: ['src/db.ts'],
      filesCreated: ['src/migrations/001.sql'],
      patterns: ['active-record'],
    });

    await storeWorkerResult('db-task', result, config);

    const raw = await readFile(fallbackPath, 'utf-8');
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>;
    const entry = entries[0];

    expect(entry['filesModified']).toEqual(['src/db.ts']);
    expect(entry['filesCreated']).toEqual(['src/migrations/001.sql']);
    expect(entry['patterns']).toEqual(['active-record']);
  });

  it('still writes local file even when Graphiti POST fails', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config: FleetMemoryConfig = {
      endpoint: 'http://graphiti.local',
      groupId: 'g',
      fallbackPath,
      available: true,
    };

    // Simulate Graphiti POST failure
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 500 }),
    );

    const result = makeWorkerResult({ taskName: 'failing-remote-task' });
    await storeWorkerResult('failing-remote-task', result, config);

    const raw = await readFile(fallbackPath, 'utf-8');
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]['taskName']).toBe('failing-remote-task');
  });

  it('still writes local file even when Graphiti fetch throws', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config: FleetMemoryConfig = {
      endpoint: 'http://graphiti.local',
      groupId: 'g',
      fallbackPath,
      available: true,
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('Network down')),
    );

    const result = makeWorkerResult({ taskName: 'network-error-task' });
    await storeWorkerResult('network-error-task', result, config);

    const raw = await readFile(fallbackPath, 'utf-8');
    const entries = JSON.parse(raw) as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]['taskName']).toBe('network-error-task');
  });
});

// ---------------------------------------------------------------------------
// queryFleetContext
// ---------------------------------------------------------------------------

describe('queryFleetContext', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempDir();
    vi.resetAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('returns empty FleetContext when no .memory.json file exists', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    const context = await queryFleetContext('build the auth module', config);

    expect(context.entities).toEqual([]);
    expect(context.facts).toEqual([]);
    expect(context.patterns).toEqual([]);
  });

  it('returns empty FleetContext when .memory.json is empty array', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    await writeFile(fallbackPath, JSON.stringify([]), 'utf-8');
    const config = makeUnavailableConfig(fallbackPath);

    const context = await queryFleetContext('build the auth module', config);

    expect(context.entities).toEqual([]);
    expect(context.facts).toEqual([]);
    expect(context.patterns).toEqual([]);
  });

  it('returns empty FleetContext when no entries match the task description', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    // Store an unrelated entry
    await storeWorkerResult(
      'database-migration',
      makeWorkerResult({
        taskName: 'database-migration',
        decisions: ['use-flyway'],
        patterns: ['migration-pattern'],
      }),
      config,
    );

    const context = await queryFleetContext('implement UI components', config);

    expect(context.entities).toEqual([]);
    expect(context.facts).toEqual([]);
    expect(context.patterns).toEqual([]);
  });

  it('returns matching results when task description matches a taskName', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    await storeWorkerResult(
      'auth-api',
      makeWorkerResult({
        taskName: 'auth-api',
        filesModified: ['src/auth.ts'],
        filesCreated: ['src/tokens.ts'],
        decisions: ['use-jwt'],
        patterns: ['bearer-token'],
      }),
      config,
    );

    // Query is a substring of the stored taskName — the local fallback uses
    // haystack.includes(needle), so the needle must appear verbatim in the
    // concatenated fields of the entry.
    const context = await queryFleetContext('auth-api', config);

    expect(context.entities).toHaveLength(1);
    expect(context.entities[0].name).toBe('auth-api');
    expect(context.entities[0].type).toBe('task');
    expect(context.entities[0].summary).toContain('src/auth.ts');
    expect(context.entities[0].summary).toContain('src/tokens.ts');
  });

  it('maps decisions to facts with subject/predicate/object shape', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    await storeWorkerResult(
      'auth-api',
      makeWorkerResult({
        taskName: 'auth-api',
        decisions: ['use-jwt', 'bcrypt-for-passwords'],
        patterns: [],
      }),
      config,
    );

    // 'auth-api' appears verbatim in the stored taskName field.
    const context = await queryFleetContext('auth-api', config);

    expect(context.facts).toHaveLength(2);
    expect(context.facts[0]).toEqual({
      subject: 'auth-api',
      predicate: 'decided',
      object: 'use-jwt',
    });
    expect(context.facts[1]).toEqual({
      subject: 'auth-api',
      predicate: 'decided',
      object: 'bcrypt-for-passwords',
    });
  });

  it('returns deduplicated patterns from all matching entries', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    // Two tasks with overlapping patterns
    await storeWorkerResult(
      'auth-api',
      makeWorkerResult({
        taskName: 'auth-api',
        patterns: ['repository-pattern', 'bearer-token'],
        decisions: [],
      }),
      config,
    );
    await storeWorkerResult(
      'auth-refresh',
      makeWorkerResult({
        taskName: 'auth-refresh',
        patterns: ['bearer-token', 'retry-logic'],
        decisions: [],
      }),
      config,
    );

    // 'auth' is a substring of both 'auth-api' and 'auth-refresh' taskNames.
    const context = await queryFleetContext('auth', config);

    // bearer-token should appear only once despite being in both entries
    const patternCount = context.patterns.filter(
      (p) => p === 'bearer-token',
    ).length;
    expect(patternCount).toBe(1);
    expect(context.patterns).toContain('repository-pattern');
    expect(context.patterns).toContain('retry-logic');
  });

  it('matches entries by decision text, not just taskName', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    await storeWorkerResult(
      'infrastructure-task',
      makeWorkerResult({
        taskName: 'infrastructure-task',
        decisions: ['adopt-kubernetes-for-orchestration'],
        patterns: ['k8s-deployment'],
      }),
      config,
    );

    // Query by a term that appears in the decision, not the taskName
    const context = await queryFleetContext('kubernetes', config);

    expect(context.entities).toHaveLength(1);
    expect(context.entities[0].name).toBe('infrastructure-task');
    expect(context.patterns).toContain('k8s-deployment');
  });

  it('matches entries by pattern text', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    await storeWorkerResult(
      'data-layer',
      makeWorkerResult({
        taskName: 'data-layer',
        patterns: ['cqrs-event-sourcing'],
        decisions: [],
      }),
      config,
    );

    const context = await queryFleetContext('cqrs', config);

    expect(context.entities).toHaveLength(1);
    expect(context.entities[0].name).toBe('data-layer');
  });

  it('returns empty FleetContext when .memory.json contains invalid JSON', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    await writeFile(fallbackPath, 'not-valid-json{{{', 'utf-8');
    const config = makeUnavailableConfig(fallbackPath);

    const context = await queryFleetContext('anything', config);

    expect(context.entities).toEqual([]);
    expect(context.facts).toEqual([]);
    expect(context.patterns).toEqual([]);
  });

  it('aggregates entities and facts from multiple matching entries', async () => {
    const fallbackPath = join(tempDir, '.memory.json');
    const config = makeUnavailableConfig(fallbackPath);

    await storeWorkerResult(
      'payment-api',
      makeWorkerResult({
        taskName: 'payment-api',
        decisions: ['use-stripe'],
        patterns: [],
      }),
      config,
    );
    await storeWorkerResult(
      'payment-webhook',
      makeWorkerResult({
        taskName: 'payment-webhook',
        decisions: ['idempotency-keys'],
        patterns: [],
      }),
      config,
    );

    const context = await queryFleetContext('payment', config);

    expect(context.entities).toHaveLength(2);
    const names = context.entities.map((e) => e.name);
    expect(names).toContain('payment-api');
    expect(names).toContain('payment-webhook');

    expect(context.facts).toHaveLength(2);
    const objects = context.facts.map((f) => f.object);
    expect(objects).toContain('use-stripe');
    expect(objects).toContain('idempotency-keys');
  });
});
