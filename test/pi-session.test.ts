/**
 * Unit tests for src/pi-session.ts
 *
 * The Pi SDK (@mariozechner/pi-coding-agent) is a peer dependency that is not
 * installed at dev time.  All tests in this file mock the dynamic import that
 * getPiModule() performs so the tests never touch the real SDK.
 *
 * Mocking strategy
 * ----------------
 * `vi.mock()` factories are hoisted to the top of the file and evaluated once.
 * To keep the factory's exported values in sync with per-test mock resets we
 * route all SDK exports through a stable "controls" object.  The factory reads
 * `controls.X` at call time, so any test can mutate `controls` before invoking
 * the SUT and the factory will pick up the new value.
 *
 * The `_piModule` singleton inside pi-session.ts caches the first successful
 * dynamic import.  Tests that need a fresh cache use `vi.resetModules()` and
 * re-import the SUT; because the vi.mock() intercept is re-registered for each
 * module graph, the factory still runs through `controls`.
 */

// ---------------------------------------------------------------------------
// Stable controls object — the vi.mock factory reads through this at call time
// ---------------------------------------------------------------------------

type MockFn = ReturnType<typeof vi.fn>;

interface MockControls {
  reload: MockFn;
  subscribe: MockFn;
  prompt: MockFn;
  dispose: MockFn;
  inMemory: MockFn;
  createAgentSession: MockFn;
  DefaultResourceLoader: MockFn;
}

// These are module-level `let` bindings so resetMocks() can replace them.
// The vi.mock factory closure reads `controls` (the object), not the individual
// properties, so the factory always sees the latest values.
let controls: MockControls;

function buildPiSession() {
  return {
    prompt: controls.prompt,
    subscribe: controls.subscribe,
    dispose: controls.dispose,
    getLastAssistantText: vi.fn().mockReturnValue(''),
    messages: [] as unknown[],
  };
}

function resetMocks() {
  const reload = vi.fn().mockResolvedValue(undefined);
  const dispose = vi.fn();
  const subscribe = vi.fn().mockReturnValue(vi.fn()); // returns unsubscribe fn
  const prompt = vi.fn().mockResolvedValue(undefined);
  const inMemory = vi.fn().mockReturnValue({ type: 'in-memory-manager' });

  // Capture the mock fns before building the session so the session closure
  // sees the same instances that individual tests will reference via `controls`.
  controls = {
    reload,
    dispose,
    subscribe,
    prompt,
    inMemory,
    // Populated below.
    createAgentSession: vi.fn(),
    DefaultResourceLoader: vi.fn(),
  };

  controls.createAgentSession = vi
    .fn()
    .mockResolvedValue({ session: buildPiSession() });

  controls.DefaultResourceLoader = vi.fn().mockImplementation(() => ({
    reload: controls.reload,
  }));
}

// Initialise before the vi.mock factory is hoisted.
resetMocks();

// The factory is evaluated once per module graph.  It always reads through
// `controls` so per-test calls to resetMocks() are picked up automatically.
vi.mock('@mariozechner/pi-coding-agent', () => ({
  get DefaultResourceLoader() {
    return controls.DefaultResourceLoader;
  },
  get createAgentSession() {
    return controls.createAgentSession;
  },
  get SessionManager() {
    return { inMemory: controls.inMemory };
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid HarnessAgentConfig used across multiple tests. */
const BASE_CONFIG = {
  workspace: '/workspace/project',
  extensions: ['/ext/harness.ts', '/ext/tools.ts'],
  heartbeat: { enabled: true, intervalMs: 60_000 },
  harness: { maxWorkers: 3, staggerMs: 5_000, tmuxServer: 'pi-harness' },
};

type PiSessionModule = typeof import('../src/pi-session.js');

// ---------------------------------------------------------------------------
// createHarnessSession
// ---------------------------------------------------------------------------

describe('createHarnessSession', () => {
  let mod: PiSessionModule;

  beforeEach(async () => {
    // Reset call history and replace mock implementations each test.
    // We do NOT call vi.resetModules() here — keeping the same module instance
    // means the vi.mock intercept stays active without re-registration.
    resetMocks();
    vi.clearAllMocks();
    mod = await import('../src/pi-session.js');
  });

  it('constructs DefaultResourceLoader with cwd and additionalExtensionPaths', async () => {
    await mod.createHarnessSession(BASE_CONFIG);

    expect(controls.DefaultResourceLoader).toHaveBeenCalledOnce();
    expect(controls.DefaultResourceLoader).toHaveBeenCalledWith({
      cwd: BASE_CONFIG.workspace,
      additionalExtensionPaths: BASE_CONFIG.extensions,
    });
  });

  it('calls loader.reload() before createAgentSession', async () => {
    const callOrder: string[] = [];

    controls.reload = vi.fn().mockImplementation(async () => {
      callOrder.push('reload');
    });

    // Rebuild DefaultResourceLoader to use the new reload fn.
    controls.DefaultResourceLoader = vi.fn().mockImplementation(() => ({
      reload: controls.reload,
    }));

    controls.createAgentSession = vi.fn().mockImplementation(async () => {
      callOrder.push('createAgentSession');
      return { session: buildPiSession() };
    });

    await mod.createHarnessSession(BASE_CONFIG);

    expect(callOrder).toEqual(['reload', 'createAgentSession']);
  });

  it('passes the workspace cwd, loader, and in-memory session manager to createAgentSession', async () => {
    const fakeManager = { type: 'in-memory-manager' };
    controls.inMemory = vi.fn().mockReturnValue(fakeManager);

    const loader = { reload: controls.reload };
    controls.DefaultResourceLoader = vi.fn().mockImplementation(() => loader);

    await mod.createHarnessSession(BASE_CONFIG);

    expect(controls.createAgentSession).toHaveBeenCalledWith({
      cwd: BASE_CONFIG.workspace,
      resourceLoader: loader,
      sessionManager: fakeManager,
    });
  });

  it('returns a HarnessSession with the piSession and workspace', async () => {
    const result = await mod.createHarnessSession(BASE_CONFIG);

    expect(result.workspace).toBe(BASE_CONFIG.workspace);
    expect(result.piSession).toBeDefined();
    expect(typeof result.piSession.prompt).toBe('function');
  });

  it('caches the pi module: DefaultResourceLoader is called for each createHarnessSession invocation', async () => {
    // Two calls to createHarnessSession — the underlying dynamic import is
    // cached after the first call, but DefaultResourceLoader must be
    // instantiated on every call (one per session).
    await mod.createHarnessSession(BASE_CONFIG);
    await mod.createHarnessSession(BASE_CONFIG);

    expect(controls.DefaultResourceLoader).toHaveBeenCalledTimes(2);
  });

  it('throws a descriptive error when the peer dependency is not installed', async () => {
    // Use a fresh module graph so the _piModule cache is null and the failing
    // import is actually attempted.
    vi.resetModules();
    vi.doMock('@mariozechner/pi-coding-agent', () => {
      throw new Error('Cannot find module');
    });

    const freshMod: PiSessionModule = await import('../src/pi-session.js');

    await expect(freshMod.createHarnessSession(BASE_CONFIG)).rejects.toThrow(
      /Peer dependency @mariozechner\/pi-coding-agent is not installed/,
    );

    // Restore normal mock so subsequent tests are unaffected.
    vi.doUnmock('@mariozechner/pi-coding-agent');
    vi.resetModules();
  });
});

// ---------------------------------------------------------------------------
// runHarnessAgent
// ---------------------------------------------------------------------------

describe('runHarnessAgent', () => {
  let mod: PiSessionModule;

  beforeEach(async () => {
    resetMocks();
    vi.clearAllMocks();
    mod = await import('../src/pi-session.js');
  });

  /** Builds a HarnessSession-shaped object backed by the current controls. */
  function makeSession(
    overrides?: Partial<{
      getLastAssistantText: () => string;
      messages: unknown[];
    }>,
  ) {
    return {
      piSession: {
        prompt: controls.prompt,
        subscribe: controls.subscribe,
        dispose: controls.dispose,
        getLastAssistantText:
          overrides?.getLastAssistantText ?? vi.fn().mockReturnValue(''),
        messages: overrides?.messages ?? [],
      },
      workspace: '/workspace/project',
    };
  }

  it('calls session.piSession.prompt() with the supplied prompt text', async () => {
    const session = makeSession();
    await mod.runHarnessAgent(session, 'List TypeScript files.');

    expect(controls.prompt).toHaveBeenCalledOnce();
    expect(controls.prompt).toHaveBeenCalledWith('List TypeScript files.');
  });

  it('returns the text from getLastAssistantText after prompt resolves', async () => {
    const session = makeSession({
      getLastAssistantText: vi.fn().mockReturnValue('Here are the files.'),
    });

    const result = await mod.runHarnessAgent(session, 'List files.');
    expect(result).toBe('Here are the files.');
  });

  it('falls back to walking messages[] when getLastAssistantText is absent', async () => {
    const session = {
      piSession: {
        prompt: controls.prompt,
        subscribe: controls.subscribe,
        dispose: controls.dispose,
        // No getLastAssistantText property.
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hello' }] },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'response text' }],
          },
        ],
      },
      workspace: '/workspace/project',
    };

    const result = await mod.runHarnessAgent(session, 'hello');
    expect(result).toBe('response text');
  });

  it('returns empty string when no assistant messages exist', async () => {
    const session = makeSession({
      getLastAssistantText: vi.fn().mockReturnValue(''),
      messages: [],
    });

    const result = await mod.runHarnessAgent(session, 'any prompt');
    expect(result).toBe('');
  });

  it('unsubscribes after prompt resolves', async () => {
    const unsubscribe = vi.fn();
    controls.subscribe = vi.fn().mockReturnValue(unsubscribe);
    const session = makeSession();

    await mod.runHarnessAgent(session, 'test');

    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('unsubscribes even when prompt() rejects', async () => {
    const unsubscribe = vi.fn();
    controls.subscribe = vi.fn().mockReturnValue(unsubscribe);
    controls.prompt = vi.fn().mockRejectedValue(new Error('API failure'));
    const session = makeSession();

    await expect(mod.runHarnessAgent(session, 'test')).rejects.toThrow(
      'API failure',
    );

    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// subscribeToSession
// ---------------------------------------------------------------------------

describe('subscribeToSession', () => {
  let mod: PiSessionModule;

  beforeEach(async () => {
    resetMocks();
    vi.clearAllMocks();
    mod = await import('../src/pi-session.js');
  });

  /** Captures the listener registered with piSession.subscribe(). */
  function makeSessionWithListener() {
    let capturedListener: ((event: unknown) => void) | null = null;
    const unsubscribe = vi.fn();

    const piSession = {
      prompt: controls.prompt,
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        capturedListener = listener;
        return unsubscribe;
      }),
      dispose: controls.dispose,
      getLastAssistantText: vi.fn().mockReturnValue('final text'),
      messages: [],
    };

    const session = { piSession, workspace: '/workspace/project' };
    return {
      session,
      unsubscribe,
      emit: (event: unknown) => {
        if (capturedListener === null) throw new Error('No listener captured');
        capturedListener(event);
      },
    };
  }

  it('registers a listener with piSession.subscribe()', () => {
    const { session } = makeSessionWithListener();
    mod.subscribeToSession(session, {});
    expect(session.piSession.subscribe).toHaveBeenCalledOnce();
  });

  it('returns the unsubscribe function from piSession.subscribe()', () => {
    const { session, unsubscribe } = makeSessionWithListener();
    const stop = mod.subscribeToSession(session, {});
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('calls onAgentStart when agent_start event is emitted', () => {
    const { session, emit } = makeSessionWithListener();
    const onAgentStart = vi.fn();

    mod.subscribeToSession(session, { onAgentStart });
    emit({ type: 'agent_start' });

    expect(onAgentStart).toHaveBeenCalledOnce();
  });

  it('calls onAgentEnd with the full text when agent_end event is emitted', () => {
    const { session, emit } = makeSessionWithListener();
    const onAgentEnd = vi.fn();

    mod.subscribeToSession(session, { onAgentEnd });
    emit({ type: 'agent_end' });

    expect(onAgentEnd).toHaveBeenCalledOnce();
    // getLastAssistantText returns 'final text' in our mock.
    expect(onAgentEnd).toHaveBeenCalledWith('final text');
  });

  it('calls onTextDelta when a message_update with text_delta arrives', () => {
    const { session, emit } = makeSessionWithListener();
    const onTextDelta = vi.fn();

    mod.subscribeToSession(session, { onTextDelta });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hello ' },
    });

    expect(onTextDelta).toHaveBeenCalledOnce();
    expect(onTextDelta).toHaveBeenCalledWith('Hello ');
  });

  it('does NOT call onTextDelta when the delta is an empty string', () => {
    const { session, emit } = makeSessionWithListener();
    const onTextDelta = vi.fn();

    mod.subscribeToSession(session, { onTextDelta });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '' },
    });

    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('does NOT call onTextDelta for non-text_delta assistantMessageEvent types', () => {
    const { session, emit } = makeSessionWithListener();
    const onTextDelta = vi.fn();

    mod.subscribeToSession(session, { onTextDelta });
    emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'message_start' },
    });

    expect(onTextDelta).not.toHaveBeenCalled();
  });

  it('calls onToolStart with the tool name for tool_execution_start', () => {
    const { session, emit } = makeSessionWithListener();
    const onToolStart = vi.fn();

    mod.subscribeToSession(session, { onToolStart });
    emit({ type: 'tool_execution_start', toolName: 'read_file' });

    expect(onToolStart).toHaveBeenCalledOnce();
    expect(onToolStart).toHaveBeenCalledWith('read_file');
  });

  it('uses "(unknown)" as tool name when toolName is absent on tool_execution_start', () => {
    const { session, emit } = makeSessionWithListener();
    const onToolStart = vi.fn();

    mod.subscribeToSession(session, { onToolStart });
    emit({ type: 'tool_execution_start' }); // no toolName

    expect(onToolStart).toHaveBeenCalledWith('(unknown)');
  });

  it('calls onToolEnd with tool name and text result for tool_execution_end', () => {
    const { session, emit } = makeSessionWithListener();
    const onToolEnd = vi.fn();

    mod.subscribeToSession(session, { onToolEnd });
    emit({
      type: 'tool_execution_end',
      toolName: 'write_file',
      result: {
        content: [{ type: 'text', text: 'written successfully' }],
      },
    });

    expect(onToolEnd).toHaveBeenCalledOnce();
    expect(onToolEnd).toHaveBeenCalledWith(
      'write_file',
      'written successfully',
    );
  });

  it('joins multiple text blocks in the tool result with newlines', () => {
    const { session, emit } = makeSessionWithListener();
    const onToolEnd = vi.fn();

    mod.subscribeToSession(session, { onToolEnd });
    emit({
      type: 'tool_execution_end',
      toolName: 'list_dir',
      result: {
        content: [
          { type: 'text', text: 'file1.ts' },
          { type: 'text', text: 'file2.ts' },
        ],
      },
    });

    expect(onToolEnd).toHaveBeenCalledWith('list_dir', 'file1.ts\nfile2.ts');
  });

  it('JSON-serialises a non-text result for tool_execution_end', () => {
    const { session, emit } = makeSessionWithListener();
    const onToolEnd = vi.fn();

    mod.subscribeToSession(session, { onToolEnd });
    const nonTextResult = { status: 'ok', count: 3 };
    emit({
      type: 'tool_execution_end',
      toolName: 'query',
      result: nonTextResult,
    });

    const [, resultArg] = onToolEnd.mock.calls[0];
    expect(resultArg).toBe(JSON.stringify(nonTextResult));
  });

  it('uses "(unknown)" as tool name when toolName is absent on tool_execution_end', () => {
    const { session, emit } = makeSessionWithListener();
    const onToolEnd = vi.fn();

    mod.subscribeToSession(session, { onToolEnd });
    emit({
      type: 'tool_execution_end',
      result: { content: [{ type: 'text', text: 'done' }] },
    });

    expect(onToolEnd).toHaveBeenCalledWith('(unknown)', 'done');
  });

  it('silently ignores unknown event types', () => {
    const { session, emit } = makeSessionWithListener();
    const onAgentStart = vi.fn();
    const onTextDelta = vi.fn();

    mod.subscribeToSession(session, { onAgentStart, onTextDelta });
    // Unknown Pi-internal event type.
    emit({ type: 'turn_start' });

    expect(onAgentStart).not.toHaveBeenCalled();
    expect(onTextDelta).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Error handling inside the listener
// ---------------------------------------------------------------------------

describe('subscribeToSession — error handling', () => {
  let mod: PiSessionModule;

  beforeEach(async () => {
    resetMocks();
    vi.clearAllMocks();
    mod = await import('../src/pi-session.js');
  });

  function makeSessionWithListener() {
    let capturedListener: ((event: unknown) => void) | null = null;
    const piSession = {
      prompt: controls.prompt,
      subscribe: vi.fn((listener: (event: unknown) => void) => {
        capturedListener = listener;
        return vi.fn();
      }),
      dispose: controls.dispose,
      getLastAssistantText: vi.fn().mockReturnValue(''),
      messages: [],
    };
    const session = { piSession, workspace: '/workspace' };
    return {
      session,
      emit: (event: unknown) => {
        if (capturedListener === null) throw new Error('No listener');
        capturedListener(event);
      },
    };
  }

  it('routes Error thrown inside onAgentStart to onError', () => {
    const { session, emit } = makeSessionWithListener();
    const boom = new Error('handler exploded');
    const onAgentStart = vi.fn().mockImplementation(() => {
      throw boom;
    });
    const onError = vi.fn();

    mod.subscribeToSession(session, { onAgentStart, onError });
    emit({ type: 'agent_start' });

    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('wraps a non-Error thrown inside a handler into an Error before calling onError', () => {
    const { session, emit } = makeSessionWithListener();
    const onAgentStart = vi.fn().mockImplementation(() => {
      // Throw a plain string instead of an Error instance.
      throw 'string error';
    });
    const onError = vi.fn();

    mod.subscribeToSession(session, { onAgentStart, onError });
    emit({ type: 'agent_start' });

    expect(onError).toHaveBeenCalledOnce();
    const [receivedError] = onError.mock.calls[0];
    expect(receivedError).toBeInstanceOf(Error);
    expect(receivedError.message).toContain('string error');
  });

  it('does not re-throw when onError itself is not provided', () => {
    const { session, emit } = makeSessionWithListener();
    const onAgentStart = vi.fn().mockImplementation(() => {
      throw new Error('inner error');
    });

    // No onError handler — should not surface the error to the caller.
    expect(() => {
      mod.subscribeToSession(session, { onAgentStart });
      emit({ type: 'agent_start' });
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// disposeHarnessSession
// ---------------------------------------------------------------------------

describe('disposeHarnessSession', () => {
  let mod: PiSessionModule;

  beforeEach(async () => {
    resetMocks();
    vi.clearAllMocks();
    mod = await import('../src/pi-session.js');
  });

  it('calls dispose() on the underlying piSession', () => {
    const dispose = vi.fn();
    const session = { piSession: { dispose }, workspace: '/workspace' };

    mod.disposeHarnessSession(session);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('does not throw when the piSession has no dispose method', () => {
    const session = {
      piSession: {}, // no dispose
      workspace: '/workspace',
    };

    expect(() => mod.disposeHarnessSession(session)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// isHarnessSession
// ---------------------------------------------------------------------------

describe('isHarnessSession', () => {
  let mod: PiSessionModule;

  beforeEach(async () => {
    resetMocks();
    vi.clearAllMocks();
    mod = await import('../src/pi-session.js');
  });

  it('returns true for a valid HarnessSession shape', () => {
    expect(
      mod.isHarnessSession({ piSession: {}, workspace: '/workspace' }),
    ).toBe(true);
  });

  it('returns false for null', () => {
    expect(mod.isHarnessSession(null)).toBe(false);
  });

  it('returns false for a non-object', () => {
    expect(mod.isHarnessSession('string')).toBe(false);
    expect(mod.isHarnessSession(42)).toBe(false);
  });

  it('returns false when piSession key is missing', () => {
    expect(mod.isHarnessSession({ workspace: '/workspace' })).toBe(false);
  });

  it('returns false when workspace key is missing', () => {
    expect(mod.isHarnessSession({ piSession: {} })).toBe(false);
  });
});
