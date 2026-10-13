import { describe, expect, test } from 'vitest';

import { formatDuration } from '../../src/lib/callDuration.js';

describe('formatDuration', () => {
  test.each([
    [0, '0:00'],
    [5, '0:05'],
    [187, '3:07'],
    [600, '10:00'],
    [3599, '59:59'],
    [3725, '1:02:05'],
  ])('%i seconds → %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  test('never shows a negative duration', () => {
    expect(formatDuration(-4)).toBe('0:00');
  });
});
