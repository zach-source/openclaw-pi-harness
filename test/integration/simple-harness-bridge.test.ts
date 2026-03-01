/**
 * Integration test for RunMessage → channel bridge pipeline.
 *
 * Creates RunMessages of each type, formats them, bridges to a mock channel,
 * and verifies the output matches expectations.
 */

import {
  bridgeRunMessageToChannel,
  formatRunMessageForChannel,
  isRunMessage,
} from '../../src/channel-bridge.js';
import type {
  OpenClawChannel,
  RunMessage,
  RunMessageType,
} from '../../src/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeChannel(): { channel: OpenClawChannel; sent: string[] } {
  const sent: string[] = [];
  const channel: OpenClawChannel = {
    async sendMessage(text: string): Promise<void> {
      sent.push(text);
    },
    onMessage(): void {},
  };
  return { channel, sent };
}

// ---------------------------------------------------------------------------
// Full pipeline: create → validate → format → bridge
// ---------------------------------------------------------------------------

describe('RunMessage pipeline integration', () => {
  const testMessages: Array<{
    customType: RunMessageType;
    content: string;
    expectedPrefix: string;
  }> = [
    {
      customType: 'run-merge',
      content: 'Merged feature/auth into main',
      expectedPrefix: '[merge]',
    },
    {
      customType: 'run-dispatch',
      content: 'Dispatched: auth-impl [developer] (deps satisfied)',
      expectedPrefix: '[dispatch]',
    },
    {
      customType: 'run-status',
      content: 'Workers: 3 active, 0 stalled\nauth-impl: 75% [3/4]',
      expectedPrefix: '[status]',
    },
    {
      customType: 'run-complete',
      content: 'All tasks complete. 3/3 merged successfully.',
      expectedPrefix: '[complete]',
    },
    {
      customType: 'run-error',
      content: 'Worker auth-impl failed: tmux session crashed',
      expectedPrefix: '[error]',
    },
    {
      customType: 'run-stopped',
      content:
        'Run stopped. Killed 2 worker(s): auth-impl, auth-tests. State preserved.',
      expectedPrefix: '[stopped]',
    },
    {
      customType: 'run-cleanup',
      content: 'Removed 3 worktrees, 3 branches, cleaned .run/ state.',
      expectedPrefix: '[cleanup]',
    },
  ];

  it.each(testMessages)(
    '$customType passes type guard validation',
    ({ customType, content }) => {
      const msg: RunMessage = { customType, content, display: true };
      expect(isRunMessage(msg)).toBe(true);
    },
  );

  it.each(testMessages)(
    '$customType formats with $expectedPrefix prefix',
    ({ customType, content, expectedPrefix }) => {
      const msg: RunMessage = { customType, content, display: true };
      const formatted = formatRunMessageForChannel(msg);
      expect(formatted).toBe(`${expectedPrefix} ${content}`);
    },
  );

  it.each(testMessages)(
    '$customType bridges correctly to channel',
    async ({ customType, content, expectedPrefix }) => {
      const { channel, sent } = makeChannel();
      const msg: RunMessage = { customType, content, display: true };

      await bridgeRunMessageToChannel(msg, channel);

      expect(sent).toHaveLength(1);
      expect(sent[0]).toBe(`${expectedPrefix} ${content}`);
    },
  );

  it('processes all 7 message types through the full pipeline sequentially', async () => {
    const { channel, sent } = makeChannel();

    for (const { customType, content } of testMessages) {
      const msg: RunMessage = { customType, content, display: true };

      // Validate
      expect(isRunMessage(msg)).toBe(true);

      // Format + bridge
      await bridgeRunMessageToChannel(msg, channel);
    }

    expect(sent).toHaveLength(7);

    // Verify each message was prefixed correctly
    for (let i = 0; i < testMessages.length; i++) {
      const { content, expectedPrefix } = testMessages[i];
      expect(sent[i]).toBe(`${expectedPrefix} ${content}`);
    }
  });

  it('rejects invalid messages before they reach the channel', async () => {
    const { channel, sent } = makeChannel();

    const invalidMessages = [
      null,
      'just a string',
      { customType: 'run-unknown', content: 'x', display: true },
      { customType: 'run-merge', content: 42, display: true },
      { content: 'missing customType', display: true },
    ];

    for (const invalid of invalidMessages) {
      expect(isRunMessage(invalid)).toBe(false);
    }

    // No messages should have been sent
    expect(sent).toHaveLength(0);
  });
});
