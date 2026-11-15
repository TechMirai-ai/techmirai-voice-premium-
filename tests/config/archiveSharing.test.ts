import { describe, expect, test } from 'vitest';

import { analyzeSharing, type SharingEntry } from '../../src/config/archiveSharing.js';

const KEYS = ['env SHEET', 'env AUDIO', 'env TRANSCRIPT'];
const entry = (
  clientId: string,
  shared: boolean,
  keys: readonly string[] = KEYS,
): SharingEntry => ({
  clientId,
  shared,
  keys,
});

describe('analyzeSharing', () => {
  test('two demo clients that BOTH carry the flag may share: reported as info, not a conflict', () => {
    const report = analyzeSharing([entry('demo-a', true), entry('demo-b', true)]);

    expect(report.conflicts).toEqual([]);
    expect(report.sharedByDemo.map((group) => group.key)).toEqual(KEYS.slice().sort());
    for (const group of report.sharedByDemo) {
      expect(group.clients).toEqual(['demo-a', 'demo-b']);
    }
  });

  test('a flagged and an unflagged client sharing is a conflict (in either order)', () => {
    for (const entries of [
      [entry('demo-a', true), entry('real-co', false)],
      [entry('real-co', false), entry('demo-a', true)],
    ]) {
      const report = analyzeSharing(entries);

      expect(report.sharedByDemo).toEqual([]);
      expect(report.conflicts).toHaveLength(KEYS.length);
      expect(report.conflicts[0]!.clients).toEqual(['demo-a', 'real-co']);
    }
  });

  test('two unflagged clients sharing is a conflict', () => {
    const report = analyzeSharing([entry('real-a', false), entry('real-b', false)]);

    expect(report.sharedByDemo).toEqual([]);
    expect(report.conflicts.map((group) => group.key)).toEqual(KEYS.slice().sort());
  });

  test('an unflagged client sharing with a flagged PAIR still fails: the flag cannot be borrowed', () => {
    const report = analyzeSharing([
      entry('demo-a', true),
      entry('demo-b', true),
      entry('real-co', false),
    ]);

    expect(report.sharedByDemo).toEqual([]);
    expect(report.conflicts[0]!.clients).toEqual(['demo-a', 'demo-b', 'real-co']);
  });

  test('only the overlapping location is judged: a flagged pair sharing one id while an unflagged client has its own passes', () => {
    const report = analyzeSharing([
      entry('demo-a', true, ['sheetId S']),
      entry('demo-b', true, ['sheetId S']),
      entry('real-co', false, ['sheetId OWN']),
    ]);

    expect(report.conflicts).toEqual([]);
    expect(report.sharedByDemo).toEqual([{ key: 'sheetId S', clients: ['demo-a', 'demo-b'] }]);
  });

  test('clients with entirely separate locations report nothing', () => {
    const report = analyzeSharing([
      entry('real-a', false, ['env A']),
      entry('real-b', false, ['env B']),
    ]);

    expect(report).toEqual({ conflicts: [], sharedByDemo: [] });
  });

  test('a client repeating one key (e.g. same id twice) is not "sharing" with itself', () => {
    const report = analyzeSharing([entry('real-a', false, ['sheetId S', 'sheetId S'])]);

    expect(report).toEqual({ conflicts: [], sharedByDemo: [] });
  });
});
