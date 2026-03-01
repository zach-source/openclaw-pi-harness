/**
 * Unit tests for channel-bridge.ts
 *
 * Tests cover:
 *   - isRunMessage type guard (valid / invalid inputs)
 *   - formatRunMessageForChannel (all 7 customTypes)
 *   - bridgeRunMessageToChannel (success + error)
 *   - bridgeSessionToChannel (session.subscribe wiring, channel.sendMessage on agent_end)
 *   - bridgeChannelToSession (channel.onMessage wiring, session.prompt on message)
 */

import {
  bridgeChannelToSession,
  bridgeRunMessageToChannel,
  bridgeSessionToChannel,
  formatRunMessageForChannel,
  isRunMessage,
} from '../src/channel-bridge.js';
import type {
  OpenClawChannel,
  RunMessage,
  RunMessageType,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeChannel(): {
  channel: OpenClawChannel;
  sent: string[];
  messageHandler: ((text: string, images?: string[]) => void) | null;
} {
  const sent: string[] = [];
  let messageHandler: ((text: string, images?: string[]) => void) | null = null;

  const channel: OpenClawChannel = {
    async sendMessage(text: string): Promise<void> {
      sent.push(text);
    },
    onMessage(handler: (text: string, images?: string[]) => void): void {
      messageHandler = handler;
    },
  };

  return {
    channel,
    sent,
    get messageHandler() {
      return messageHandler;
    },
  };
}

function makeSession() {
  let capturedHandlers: Record<string, (...args: unknown[]) => void> = {};
  const unsubscribeSpy = vi.fn();

  const session = {
    subscribe: vi.fn(
      (handlers: Record<string, (...args: unknown[]) => void>) => {
        capturedHandlers = handlers;
        return { unsubscribe: unsubscribeSpy };
      },
    ),
    prompt: vi.fn(() => Promise.resolve()),
    promptWithImages: vi.fn(() => Promise.resolve()),
    get handlers() {
      return capturedHandlers;
    },
    unsubscribeSpy,
  };

  return session;
}

function makeRunMessage(
  customType: RunMessageType,
  content: string = 'test content',
): RunMessage {
  return { customType, content, display: true };
}

// ---------------------------------------------------------------------------
// isRunMessage
// ---------------------------------------------------------------------------

describe('isRunMessage', () => {
  it('returns true for a valid RunMessage with each customType', () => {
    const types: RunMessageType[] = [
      'run-merge',
      'run-dispatch',
      'run-status',
      'run-complete',
      'run-error',
      'run-stopped',
      'run-cleanup',
    ];

    for (const t of types) {
      expect(isRunMessage({ customType: t, content: 'x', display: true })).toBe(
        true,
      );
    }
  });

  it('returns false for null', () => {
    expect(isRunMessage(null)).toBe(false);
  });

  it('returns false for a string', () => {
    expect(isRunMessage('run-merge')).toBe(false);
  });

  it('returns false when customType is missing', () => {
    expect(isRunMessage({ content: 'x', display: true })).toBe(false);
  });

  it('returns false for an unknown customType', () => {
    expect(
      isRunMessage({ customType: 'run-unknown', content: 'x', display: true }),
    ).toBe(false);
  });

  it('returns false when content is not a string', () => {
    expect(
      isRunMessage({ customType: 'run-merge', content: 42, display: true }),
    ).toBe(false);
  });

  it('returns false when display is not a boolean', () => {
    expect(
      isRunMessage({ customType: 'run-merge', content: 'x', display: 'yes' }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatRunMessageForChannel
// ---------------------------------------------------------------------------

describe('formatRunMessageForChannel', () => {
  const cases: Array<[RunMessageType, string]> = [
    ['run-merge', '[merge]'],
    ['run-dispatch', '[dispatch]'],
    ['run-status', '[status]'],
    ['run-complete', '[complete]'],
    ['run-error', '[error]'],
    ['run-stopped', '[stopped]'],
    ['run-cleanup', '[cleanup]'],
  ];

  it.each(cases)('formats %s with prefix %s', (customType, expectedPrefix) => {
    const msg = makeRunMessage(customType, 'some content');
    const output = formatRunMessageForChannel(msg);
    expect(output).toBe(`${expectedPrefix} some content`);
  });

  it('preserves multi-line content', () => {
    const msg = makeRunMessage('run-status', 'line1\nline2\nline3');
    const output = formatRunMessageForChannel(msg);
    expect(output).toBe('[status] line1\nline2\nline3');
  });
});

// ---------------------------------------------------------------------------
// bridgeRunMessageToChannel
// ---------------------------------------------------------------------------

describe('bridgeRunMessageToChannel', () => {
  it('sends the formatted message to the channel', async () => {
    const { channel, sent } = makeChannel();
    const msg = makeRunMessage('run-merge', 'Merged feature/auth into main');

    await bridgeRunMessageToChannel(msg, channel);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('[merge] Merged feature/auth into main');
  });

  it('catches and logs errors from channel.sendMessage', async () => {
    const error = new Error('channel failure');
    const channel: OpenClawChannel = {
      async sendMessage(): Promise<void> {
        throw error;
      },
      onMessage(): void {},
    };

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await bridgeRunMessageToChannel(
      makeRunMessage('run-error', 'something broke'),
      channel,
    );

    expect(consoleSpy).toHaveBeenCalledWith(
      '[channel-bridge] sendMessage failed for RunMessage',
      'run-error',
      error,
    );

    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// bridgeSessionToChannel
// ---------------------------------------------------------------------------

describe('bridgeSessionToChannel', () => {
  it('calls session.subscribe when setting up the bridge', () => {
    const session = makeSession();
    const { channel } = makeChannel();

    bridgeSessionToChannel(session, channel);

    expect(session.subscribe).toHaveBeenCalledOnce();
  });

  it('sends channel message with fullText on agent_end when fullText is non-empty', async () => {
    const session = makeSession();
    const { channel, sent } = makeChannel();

    bridgeSessionToChannel(session, channel);

    session.handlers['agent_end']('Hello from the agent!');

    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('Hello from the agent!');
  });

  it('accumulates text deltas and sends them when fullText is empty on agent_end', async () => {
    const session = makeSession();
    const { channel, sent } = makeChannel();

    bridgeSessionToChannel(session, channel);

    session.handlers['agent_start']();
    session.handlers['text_delta']('Hello');
    session.handlers['text_delta'](' world');
    session.handlers['agent_end']('');

    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('Hello world');
  });

  it('does NOT send a channel message when both fullText and buffer are empty', async () => {
    const session = makeSession();
    const { channel, sent } = makeChannel();

    bridgeSessionToChannel(session, channel);

    session.handlers['agent_start']();
    session.handlers['agent_end']('');

    await Promise.resolve();

    expect(sent).toHaveLength(0);
  });

  it('resets the buffer on agent_start', async () => {
    const session = makeSession();
    const { channel, sent } = makeChannel();

    bridgeSessionToChannel(session, channel);

    session.handlers['agent_start']();
    session.handlers['text_delta']('stale text');

    session.handlers['agent_start']();
    session.handlers['text_delta']('fresh text');
    session.handlers['agent_end']('');

    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('fresh text');
  });

  it('sends tool-start notification when notifyOnToolStart is true', async () => {
    const session = makeSession();
    const { channel, sent } = makeChannel();

    bridgeSessionToChannel(session, channel, { notifyOnToolStart: true });

    session.handlers['tool_execution_start']('Bash');

    await Promise.resolve();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe('[tool] Bash started');
  });

  it('does NOT send tool-start notification when notifyOnToolStart is false (default)', async () => {
    const session = makeSession();
    const { channel, sent } = makeChannel();

    bridgeSessionToChannel(session, channel);

    session.handlers['tool_execution_start']('Bash');

    await Promise.resolve();

    expect(sent).toHaveLength(0);
  });

  it('returns an unsubscribe function that calls subscription.unsubscribe', () => {
    const session = makeSession();
    const { channel } = makeChannel();

    const unsubscribe = bridgeSessionToChannel(session, channel);
    unsubscribe();

    expect(session.unsubscribeSpy).toHaveBeenCalledOnce();
  });

  it('returns a no-op unsubscribe when session.subscribe throws', () => {
    const session = makeSession();
    session.subscribe.mockImplementationOnce(() => {
      throw new Error('subscribe not supported');
    });
    const { channel } = makeChannel();

    const unsubscribe = bridgeSessionToChannel(session, channel);
    expect(() => unsubscribe()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// bridgeChannelToSession
// ---------------------------------------------------------------------------

describe('bridgeChannelToSession', () => {
  it('registers a message handler on the channel', () => {
    const session = makeSession();
    const channelFixture = makeChannel();

    bridgeChannelToSession(channelFixture.channel, session);

    expect(channelFixture.messageHandler).not.toBeNull();
  });

  it('calls session.prompt with the incoming text', async () => {
    const session = makeSession();
    const channelFixture = makeChannel();
    const { channel } = channelFixture;

    bridgeChannelToSession(channel, session);

    channelFixture.messageHandler!('Hello session!');

    await Promise.resolve();

    expect(session.prompt).toHaveBeenCalledOnce();
    expect(session.prompt).toHaveBeenCalledWith('Hello session!');
  });

  it('calls session.prompt with text even when images array is empty', async () => {
    const session = makeSession();
    const channelFixture = makeChannel();
    const { channel } = channelFixture;

    bridgeChannelToSession(channel, session);

    channelFixture.messageHandler!('No images here', []);

    await Promise.resolve();

    expect(session.prompt).toHaveBeenCalledWith('No images here');
  });

  it('calls session.promptWithImages when session supports it and images are present', async () => {
    const session = makeSession();
    const channelFixture = makeChannel();
    const { channel } = channelFixture;

    bridgeChannelToSession(channel, session);

    const images = ['https://example.com/img1.png'];
    channelFixture.messageHandler!('Check this image', images);

    await Promise.resolve();

    expect(session.promptWithImages).toHaveBeenCalledOnce();
    expect(session.promptWithImages).toHaveBeenCalledWith(
      'Check this image',
      images,
    );
    expect(session.prompt).not.toHaveBeenCalled();
  });

  it('falls back to session.prompt with appended image URLs when session lacks promptWithImages', async () => {
    const session = makeSession();
    const sessionWithoutImages = {
      prompt: session.prompt,
    };

    const channelFixture = makeChannel();
    const { channel } = channelFixture;

    bridgeChannelToSession(channel, sessionWithoutImages);

    const images = [
      'https://example.com/img1.png',
      'https://example.com/img2.png',
    ];
    channelFixture.messageHandler!('Two images', images);

    await Promise.resolve();

    expect(session.prompt).toHaveBeenCalledOnce();
    const promptArg = session.prompt.mock.calls[0][0] as string;
    expect(promptArg).toContain('Two images');
    expect(promptArg).toContain('[image 1]: https://example.com/img1.png');
    expect(promptArg).toContain('[image 2]: https://example.com/img2.png');
  });
});
