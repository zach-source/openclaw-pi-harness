/**
 * Integration test for the full OpenClaw extension lifecycle.
 *
 * Exercises cross-module interactions that unit tests cannot catch:
 *
 *   1. Session ↔ Channel bridge — bidirectional event flow with RunMessages
 *   2. Fleet memory round-trip — store results, query context, verify persistence
 *   3. Full run lifecycle — simulate a realistic /run execution from start
 *      through dispatch, merge, completion, with memory and channel output
 *
 * All I/O targets a temporary directory. No Pi SDK or Graphiti instance required.
 */

import { mkdir, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  bridgeChannelToSession,
  bridgeRunMessageToChannel,
  bridgeSessionToChannel,
  formatRunMessageForChannel,
  isRunMessage,
} from '../../src/channel-bridge.js';
import {
  configureFleetMemory,
  queryFleetContext,
  storeWorkerResult,
} from '../../src/fleet-memory.js';
import {
  disposeHarnessSession,
  isHarnessSession,
  subscribeToSession,
} from '../../src/pi-session.js';
import type {
  FleetMemoryConfig,
  OpenClawChannel,
  RunMessage,
  RunMessageType,
  WorkerResult,
} from '../../src/types.js';
import { MEMORY_FILE_PATH } from '../../src/types.js';

// ---------------------------------------------------------------------------
// Shared temp directory
// ---------------------------------------------------------------------------

let TEMP_BASE: string;

beforeAll(async () => {
  TEMP_BASE = join(tmpdir(), `openclaw-lifecycle-${crypto.randomUUID()}`);
  await mkdir(TEMP_BASE, { recursive: true });
});

afterAll(async () => {
  await rm(TEMP_BASE, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeChannel(): {
  channel: OpenClawChannel;
  sent: string[];
  triggerMessage: (text: string, images?: string[]) => void;
} {
  const sent: string[] = [];
  let handler: ((text: string, images?: string[]) => void) | null = null;

  const channel: OpenClawChannel = {
    async sendMessage(text: string): Promise<void> {
      sent.push(text);
    },
    onMessage(h: (text: string, images?: string[]) => void): void {
      handler = h;
    },
  };

  return {
    channel,
    sent,
    triggerMessage(text: string, images?: string[]) {
      handler?.(text, images);
    },
  };
}

/**
 * Creates a mock Pi session that captures subscribe listeners and exposes
 * helpers to emit events through the listener.
 *
 * Handles two subscribe patterns:
 *   - subscribeToSession: passes a single listener function
 *   - bridgeSessionToChannel: passes a handler map { agent_start, text_delta, ... }
 */
function makePiSession() {
  let listener: ((event: Record<string, unknown>) => void) | null = null;
  let handlerMap: Record<string, (...args: unknown[]) => void> | null = null;
  const unsubscribe = vi.fn();
  const promptCalls: string[] = [];

  const piSession = {
    subscribe: vi.fn((arg: unknown) => {
      if (typeof arg === 'function') {
        listener = arg as (event: Record<string, unknown>) => void;
      } else if (typeof arg === 'object' && arg !== null) {
        handlerMap = arg as Record<string, (...args: unknown[]) => void>;
      }
      // Return an unsubscribe function (for subscribeToSession) that also
      // has an .unsubscribe property (for bridgeSessionToChannel).
      const unsub = (...args: unknown[]) => unsubscribe(...args);
      unsub.unsubscribe = unsubscribe;
      return unsub;
    }),
    prompt: vi.fn(async (text: string) => {
      promptCalls.push(text);
    }),
    dispose: vi.fn(),
    getLastAssistantText: vi.fn().mockReturnValue(''),
    messages: [] as unknown[],
  };

  return {
    session: { piSession, workspace: '/test/workspace' },
    unsubscribe,
    promptCalls,
    /**
     * Emit an event through whichever subscribe pattern was used.
     *
     * For the listener pattern (subscribeToSession): passes the full event object.
     * For the handler map pattern (bridgeSessionToChannel): calls the matching
     * handler by event.type, passing remaining event values as arguments.
     */
    emit(event: Record<string, unknown>) {
      if (listener) {
        listener(event);
      } else if (handlerMap && typeof event.type === 'string') {
        const handler = handlerMap[event.type];
        if (handler) {
          // bridgeSessionToChannel handlers receive direct args, not event objects.
          // Map event types to their expected argument shapes.
          switch (event.type) {
            case 'agent_start':
              handler();
              break;
            case 'text_delta':
              handler(event.delta ?? '');
              break;
            case 'tool_execution_start':
              handler(event.toolName ?? '');
              break;
            case 'tool_execution_end':
              handler(event.toolName ?? '', event.result ?? '');
              break;
            case 'agent_end':
              handler(event.fullText ?? piSession.getLastAssistantText());
              break;
            case 'error':
              handler(event.error ?? new Error('unknown'));
              break;
            default:
              handler(event);
          }
        }
      }
    },
    setLastText(text: string) {
      piSession.getLastAssistantText.mockReturnValue(text);
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Session ↔ Channel bidirectional bridge
// ---------------------------------------------------------------------------

describe('Session ↔ Channel bidirectional bridge', () => {
  it('forwards agent text from session to channel via bridgeSessionToChannel', async () => {
    const { channel, sent } = makeChannel();
    const mockSession = {
      subscribe: vi.fn(
        (handlers: Record<string, (...args: unknown[]) => void>) => {
          // Simulate an agent turn: start → deltas → end
          handlers['agent_start']?.();
          handlers['text_delta']?.('Hello ');
          handlers['text_delta']?.('from the agent');
          handlers['agent_end']?.('Hello from the agent');
          return { unsubscribe: vi.fn() };
        },
      ),
    };

    bridgeSessionToChannel(mockSession, channel);

    // Allow fire-and-forget promises to resolve
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('Hello from the agent');
  });

  it('forwards channel messages to session via bridgeChannelToSession', async () => {
    const { channel, triggerMessage } = makeChannel();
    const promptCalls: string[] = [];
    const mockSession = {
      prompt: vi.fn(async (text: string) => {
        promptCalls.push(text);
      }),
    };

    bridgeChannelToSession(channel, mockSession);

    triggerMessage('User says hello');
    triggerMessage('Another message');

    await new Promise((r) => setTimeout(r, 10));

    expect(promptCalls).toEqual(['User says hello', 'Another message']);
  });

  it('handles bidirectional flow: channel → session → channel', async () => {
    const { channel, sent, triggerMessage } = makeChannel();
    const promptCalls: string[] = [];

    // Session that records prompts and has subscribe
    let subscribedHandlers: Record<
      string,
      (...args: unknown[]) => void
    > | null = null;
    const mockSession = {
      subscribe: vi.fn(
        (handlers: Record<string, (...args: unknown[]) => void>) => {
          subscribedHandlers = handlers;
          return { unsubscribe: vi.fn() };
        },
      ),
      prompt: vi.fn(async (text: string) => {
        promptCalls.push(text);
      }),
    };

    // Set up both directions
    bridgeSessionToChannel(mockSession, channel);
    bridgeChannelToSession(channel, mockSession);

    // User sends a message through the channel
    triggerMessage('Build the auth module');
    await new Promise((r) => setTimeout(r, 10));
    expect(promptCalls).toContain('Build the auth module');

    // Agent responds through the session
    subscribedHandlers!['agent_start']?.();
    subscribedHandlers!['agent_end']?.('I will build the auth module now.');
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toContain('I will build the auth module now.');
  });

  it('interleaves RunMessages with session events on the same channel', async () => {
    const { channel, sent } = makeChannel();

    // Session bridge sends agent response
    let subscribedHandlers: Record<
      string,
      (...args: unknown[]) => void
    > | null = null;
    const mockSession = {
      subscribe: vi.fn(
        (handlers: Record<string, (...args: unknown[]) => void>) => {
          subscribedHandlers = handlers;
          return { unsubscribe: vi.fn() };
        },
      ),
    };

    bridgeSessionToChannel(mockSession, channel);

    // Agent produces a response
    subscribedHandlers!['agent_start']?.();
    subscribedHandlers!['agent_end']?.('Starting the run...');
    await new Promise((r) => setTimeout(r, 10));

    // RunMessages arrive from simple-harness
    const dispatch: RunMessage = {
      customType: 'run-dispatch',
      content: 'Dispatched: auth-impl [developer]',
      display: true,
    };
    await bridgeRunMessageToChannel(dispatch, channel);

    const merge: RunMessage = {
      customType: 'run-merge',
      content: 'Merged auth-impl into main',
      display: true,
    };
    await bridgeRunMessageToChannel(merge, channel);

    // Another agent response
    subscribedHandlers!['agent_start']?.();
    subscribedHandlers!['agent_end']?.('All workers dispatched.');
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toEqual([
      'Starting the run...',
      '[dispatch] Dispatched: auth-impl [developer]',
      '[merge] Merged auth-impl into main',
      'All workers dispatched.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. Fleet memory round-trip with channel output
// ---------------------------------------------------------------------------

describe('Fleet memory round-trip with channel output', () => {
  let memoryDir: string;
  let memoryFile: string;
  let config: FleetMemoryConfig;

  beforeEach(async () => {
    memoryDir = join(TEMP_BASE, `memory-${crypto.randomUUID()}`);
    memoryFile = join(memoryDir, '.memory.json');
    await mkdir(memoryDir, { recursive: true });
    config = {
      endpoint: null,
      groupId: 'integration-test',
      fallbackPath: memoryFile,
      available: false,
    };
  });

  it('stores multiple worker results and queries them back', async () => {
    const results: Array<{ name: string; result: WorkerResult }> = [
      {
        name: 'auth-impl',
        result: {
          taskName: 'auth-impl',
          filesModified: ['src/auth.ts', 'src/middleware.ts'],
          filesCreated: ['src/jwt.ts'],
          decisions: ['Use JWT with HS256', 'Store tokens in httpOnly cookies'],
          patterns: ['middleware-pattern', 'bearer-auth'],
        },
      },
      {
        name: 'auth-tests',
        result: {
          taskName: 'auth-tests',
          filesModified: [],
          filesCreated: ['test/auth.test.ts', 'test/jwt.test.ts'],
          decisions: ['Use vitest for testing'],
          patterns: ['test-isolation', 'bearer-auth'],
        },
      },
      {
        name: 'db-migration',
        result: {
          taskName: 'db-migration',
          filesModified: ['src/db.ts'],
          filesCreated: ['migrations/001.sql'],
          decisions: ['Use Flyway for migrations'],
          patterns: ['active-record'],
        },
      },
    ];

    // Store all results
    for (const { name, result } of results) {
      await storeWorkerResult(name, result, config);
    }

    // Verify file was written with all entries
    const raw = await readFile(memoryFile, 'utf-8');
    const entries = JSON.parse(raw) as unknown[];
    expect(entries).toHaveLength(3);

    // Query for auth-related tasks
    const authContext = await queryFleetContext('auth', config);
    expect(authContext.entities).toHaveLength(2);
    const authNames = authContext.entities.map((e) => e.name).sort();
    expect(authNames).toEqual(['auth-impl', 'auth-tests']);

    // Auth patterns should be deduplicated
    expect(
      authContext.patterns.filter((p) => p === 'bearer-auth'),
    ).toHaveLength(1);

    // Query for db-related tasks
    const dbContext = await queryFleetContext('db-migration', config);
    expect(dbContext.entities).toHaveLength(1);
    expect(dbContext.entities[0].name).toBe('db-migration');
    expect(dbContext.facts).toHaveLength(1);
    expect(dbContext.facts[0].object).toBe('Use Flyway for migrations');

    // Query for something unrelated
    const emptyContext = await queryFleetContext(
      'completely-unrelated-xyz',
      config,
    );
    expect(emptyContext.entities).toHaveLength(0);
  });

  it('formats fleet context query results into RunMessages for channel delivery', async () => {
    const { channel, sent } = makeChannel();

    // Store a worker result
    await storeWorkerResult(
      'api-refactor',
      {
        taskName: 'api-refactor',
        filesModified: ['src/api.ts'],
        filesCreated: [],
        decisions: ['Switch from REST to GraphQL'],
        patterns: ['graphql-schema-first'],
      },
      config,
    );

    // Query context
    const context = await queryFleetContext('api-refactor', config);
    expect(context.entities.length).toBeGreaterThan(0);

    // Format as a status RunMessage and bridge to channel
    const statusContent = [
      `Found ${context.entities.length} relevant task(s)`,
      ...context.facts.map((f) => `  ${f.subject}: ${f.object}`),
      ...context.patterns.map((p) => `  pattern: ${p}`),
    ].join('\n');

    const statusMsg: RunMessage = {
      customType: 'run-status',
      content: statusContent,
      display: true,
    };

    expect(isRunMessage(statusMsg)).toBe(true);
    await bridgeRunMessageToChannel(statusMsg, channel);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('[status]');
    expect(sent[0]).toContain('1 relevant task');
    expect(sent[0]).toContain('Switch from REST to GraphQL');
    expect(sent[0]).toContain('graphql-schema-first');
  });
});

// ---------------------------------------------------------------------------
// 3. Full run lifecycle simulation
// ---------------------------------------------------------------------------

describe('Full run lifecycle simulation', () => {
  let memoryDir: string;
  let memoryFile: string;
  let memoryConfig: FleetMemoryConfig;

  beforeEach(async () => {
    memoryDir = join(TEMP_BASE, `lifecycle-${crypto.randomUUID()}`);
    memoryFile = join(memoryDir, '.memory.json');
    await mkdir(memoryDir, { recursive: true });
    memoryConfig = {
      endpoint: null,
      groupId: 'lifecycle-test',
      fallbackPath: memoryFile,
      available: false,
    };
  });

  it('simulates a complete /run cycle: dispatch → work → merge → complete', async () => {
    const { channel, sent } = makeChannel();
    const mock = makePiSession();

    // Wire up session → channel bridge
    bridgeSessionToChannel(mock.session.piSession, channel);

    // Phase 1: Agent acknowledges the /run command
    mock.emit({ type: 'agent_start' });
    mock.setLastText('Analyzing objective and generating task plan...');
    mock.emit({ type: 'agent_end' });
    await new Promise((r) => setTimeout(r, 10));

    expect(sent).toContain('Analyzing objective and generating task plan...');

    // Phase 2: Tasks dispatched (RunMessages from simple-harness)
    const dispatches: RunMessage[] = [
      {
        customType: 'run-dispatch',
        content: 'Dispatched: auth-impl [developer] (no deps)',
        display: true,
      },
      {
        customType: 'run-dispatch',
        content: 'Dispatched: auth-tests [tester] (waiting on auth-impl)',
        display: true,
      },
    ];

    for (const msg of dispatches) {
      await bridgeRunMessageToChannel(msg, channel);
    }

    // Phase 3: Status update
    const status: RunMessage = {
      customType: 'run-status',
      content:
        'Workers: 2 active\n  auth-impl: 50% [2/4]\n  auth-tests: 0% [0/3] (blocked)',
      display: true,
    };
    await bridgeRunMessageToChannel(status, channel);

    // Phase 4: First worker completes → store result + merge
    const implResult: WorkerResult = {
      taskName: 'auth-impl',
      filesModified: ['src/auth.ts'],
      filesCreated: ['src/jwt-utils.ts'],
      decisions: ['JWT with RS256'],
      patterns: ['middleware-chain'],
    };
    await storeWorkerResult('auth-impl', implResult, memoryConfig);

    const mergeMsg: RunMessage = {
      customType: 'run-merge',
      content: 'Merged auth-impl (branch run/auth-impl) into main',
      display: true,
    };
    await bridgeRunMessageToChannel(mergeMsg, channel);

    // Phase 5: Second worker queries context from first worker's results
    const context = await queryFleetContext('auth', memoryConfig);
    expect(context.entities.length).toBeGreaterThan(0);
    expect(context.patterns).toContain('middleware-chain');

    // Phase 6: Second worker completes
    const testResult: WorkerResult = {
      taskName: 'auth-tests',
      filesModified: [],
      filesCreated: ['test/auth.test.ts'],
      decisions: ['100% branch coverage target'],
      patterns: ['test-isolation'],
    };
    await storeWorkerResult('auth-tests', testResult, memoryConfig);

    const mergeMsg2: RunMessage = {
      customType: 'run-merge',
      content: 'Merged auth-tests (branch run/auth-tests) into main',
      display: true,
    };
    await bridgeRunMessageToChannel(mergeMsg2, channel);

    // Phase 7: Run completes
    const completeMsg: RunMessage = {
      customType: 'run-complete',
      content: 'All 2 tasks complete. 2/2 merged successfully.',
      display: true,
    };
    await bridgeRunMessageToChannel(completeMsg, channel);

    // Verify the full channel output sequence
    expect(sent).toEqual([
      'Analyzing objective and generating task plan...',
      '[dispatch] Dispatched: auth-impl [developer] (no deps)',
      '[dispatch] Dispatched: auth-tests [tester] (waiting on auth-impl)',
      '[status] Workers: 2 active\n  auth-impl: 50% [2/4]\n  auth-tests: 0% [0/3] (blocked)',
      '[merge] Merged auth-impl (branch run/auth-impl) into main',
      '[merge] Merged auth-tests (branch run/auth-tests) into main',
      '[complete] All 2 tasks complete. 2/2 merged successfully.',
    ]);

    // Verify fleet memory contains both results
    const raw = await readFile(memoryFile, 'utf-8');
    const entries = JSON.parse(raw) as Array<{ taskName: string }>;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.taskName).sort()).toEqual([
      'auth-impl',
      'auth-tests',
    ]);
  });

  it('simulates an error scenario: dispatch → error → stop → cleanup', async () => {
    const { channel, sent } = makeChannel();

    // Dispatch
    await bridgeRunMessageToChannel(
      {
        customType: 'run-dispatch',
        content: 'Dispatched: build-service [developer]',
        display: true,
      },
      channel,
    );

    // Error occurs
    await bridgeRunMessageToChannel(
      {
        customType: 'run-error',
        content: 'Worker build-service crashed: OOM killed by system',
        display: true,
      },
      channel,
    );

    // User stops the run
    await bridgeRunMessageToChannel(
      {
        customType: 'run-stopped',
        content:
          'Run stopped. Killed 1 worker(s): build-service. State preserved.',
        display: true,
      },
      channel,
    );

    // User cleans up
    await bridgeRunMessageToChannel(
      {
        customType: 'run-cleanup',
        content: 'Removed 1 worktree, 1 branch, cleaned .run/ state.',
        display: true,
      },
      channel,
    );

    expect(sent).toEqual([
      '[dispatch] Dispatched: build-service [developer]',
      '[error] Worker build-service crashed: OOM killed by system',
      '[stopped] Run stopped. Killed 1 worker(s): build-service. State preserved.',
      '[cleanup] Removed 1 worktree, 1 branch, cleaned .run/ state.',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Pi session lifecycle with subscribeToSession
// ---------------------------------------------------------------------------

describe('Pi session lifecycle integration', () => {
  it('subscribeToSession relays events to handlers and unsubscribes cleanly', () => {
    const mock = makePiSession();
    const events: string[] = [];

    const stop = subscribeToSession(mock.session, {
      onAgentStart: () => events.push('start'),
      onTextDelta: (d) => events.push(`delta:${d}`),
      onToolStart: (name) => events.push(`tool-start:${name}`),
      onToolEnd: (name, result) => events.push(`tool-end:${name}:${result}`),
      onAgentEnd: (text) => events.push(`end:${text}`),
      onError: (err) => events.push(`error:${err.message}`),
    });

    // Simulate a full agent turn
    mock.emit({ type: 'agent_start' });
    mock.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Building...' },
    });
    mock.emit({
      type: 'tool_execution_start',
      toolName: 'bash',
    });
    mock.emit({
      type: 'tool_execution_end',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'npm test passed' }] },
    });
    mock.setLastText('Build complete.');
    mock.emit({ type: 'agent_end' });

    expect(events).toEqual([
      'start',
      'delta:Building...',
      'tool-start:bash',
      'tool-end:bash:npm test passed',
      'end:Build complete.',
    ]);

    // Unsubscribe and verify no further events are captured
    stop();
    expect(mock.unsubscribe).toHaveBeenCalledOnce();
  });

  it('subscribeToSession routes handler errors to onError', () => {
    const mock = makePiSession();
    const errors: string[] = [];

    subscribeToSession(mock.session, {
      onAgentStart: () => {
        throw new Error('handler boom');
      },
      onError: (err) => errors.push(err.message),
    });

    mock.emit({ type: 'agent_start' });

    expect(errors).toEqual(['handler boom']);
  });

  it('isHarnessSession validates mock session shape', () => {
    const mock = makePiSession();
    expect(isHarnessSession(mock.session)).toBe(true);
    expect(isHarnessSession(null)).toBe(false);
    expect(isHarnessSession({ piSession: {} })).toBe(false);
  });

  it('disposeHarnessSession calls dispose on the underlying session', () => {
    const mock = makePiSession();
    disposeHarnessSession(mock.session);
    expect(mock.session.piSession.dispose).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// 5. configureFleetMemory integration
// ---------------------------------------------------------------------------

describe('configureFleetMemory integration', () => {
  it('creates fallback directory and returns offline config without endpoint', async () => {
    const nestedPath = join(
      TEMP_BASE,
      `deep-${crypto.randomUUID()}`,
      'sub',
      'dir',
      '.memory.json',
    );

    const config = await configureFleetMemory({
      groupId: 'test-group',
      fallbackPath: nestedPath,
    });

    expect(config.available).toBe(false);
    expect(config.endpoint).toBeNull();
    expect(config.groupId).toBe('test-group');
    expect(config.fallbackPath).toBe(nestedPath);

    // Store and query should work with this config
    await storeWorkerResult(
      'test-task',
      {
        taskName: 'test-task',
        filesModified: ['a.ts'],
        filesCreated: [],
        decisions: ['keep it simple'],
        patterns: ['kiss'],
      },
      config,
    );

    const context = await queryFleetContext('test-task', config);
    expect(context.entities).toHaveLength(1);
    expect(context.entities[0].name).toBe('test-task');
  });
});

// ---------------------------------------------------------------------------
// 6. MEMORY_FILE_PATH constant coherence
// ---------------------------------------------------------------------------

describe('MEMORY_FILE_PATH constant', () => {
  it('uses .run/ directory consistent with simple-harness RUN_DIR', () => {
    expect(MEMORY_FILE_PATH).toBe('.run/.memory.json');
    expect(MEMORY_FILE_PATH).toMatch(/^\.run\//);
  });
});
