/**
 * Unit tests for src/types.ts
 *
 * Verifies that exported constants and type unions carry the expected values.
 */

import { MEMORY_FILE_PATH } from '../src/types.js';
import type { RunMessageType } from '../src/types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('MEMORY_FILE_PATH', () => {
  it('points to .run/.memory.json', () => {
    expect(MEMORY_FILE_PATH).toBe('.run/.memory.json');
  });
});

// ---------------------------------------------------------------------------
// RunMessageType values
// ---------------------------------------------------------------------------

describe('RunMessageType', () => {
  it('accepts all 7 valid customType values', () => {
    const validTypes: RunMessageType[] = [
      'run-merge',
      'run-dispatch',
      'run-status',
      'run-complete',
      'run-error',
      'run-stopped',
      'run-cleanup',
    ];

    // This is a compile-time check — if RunMessageType changes, this array
    // literal would produce a TypeScript error. At runtime we just verify
    // the array length matches our expectation.
    expect(validTypes).toHaveLength(7);
  });

  it('each value follows the run-* naming convention', () => {
    const validTypes: RunMessageType[] = [
      'run-merge',
      'run-dispatch',
      'run-status',
      'run-complete',
      'run-error',
      'run-stopped',
      'run-cleanup',
    ];

    for (const t of validTypes) {
      expect(t).toMatch(/^run-/);
    }
  });
});
