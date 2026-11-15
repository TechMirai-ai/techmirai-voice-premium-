import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import type { ClientConfig } from '../../src/config/schema.js';
import { resolveArchiveDestination } from '../../src/google/archiveDestination.js';

const SAKURA_ENV = {
  GOOGLE_ARCHIVE_SHEET_ID: 'sakura-sheet',
  GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: 'sakura-audio',
  GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID: 'sakura-transcripts',
};
const KANTO_ENV = {
  GOOGLE_ARCHIVE_KANTO_SHEET_ID: 'kanto-sheet',
  GOOGLE_ARCHIVE_KANTO_AUDIO_FOLDER_ID: 'kanto-audio',
  GOOGLE_ARCHIVE_KANTO_TRANSCRIPT_FOLDER_ID: 'kanto-transcripts',
};

describe('resolveArchiveDestination', () => {
  test('resolves each client from ITS OWN variables, even when both are set', () => {
    const env = { ...SAKURA_ENV, ...KANTO_ENV };

    expect(resolveArchiveDestination('sakura-seikotsuin', loadClient, env)).toEqual({
      ok: true,
      destination: {
        sheetId: 'sakura-sheet',
        audioFolderId: 'sakura-audio',
        transcriptFolderId: 'sakura-transcripts',
      },
    });
    expect(resolveArchiveDestination('kanto-city-gas-demo', loadClient, env)).toEqual({
      ok: true,
      destination: {
        sheetId: 'kanto-sheet',
        audioFolderId: 'kanto-audio',
        transcriptFolderId: 'kanto-transcripts',
      },
    });
  });

  test('Kanto with only Sakura’s variables set fails closed: it never borrows Sakura’s destination', () => {
    const result = resolveArchiveDestination('kanto-city-gas-demo', loadClient, SAKURA_ENV);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/^archive destination not configured for kanto-city-gas-demo/);
    expect(result.message).toContain('GOOGLE_ARCHIVE_KANTO_SHEET_ID');
    expect(result.message).toContain('GOOGLE_ARCHIVE_KANTO_AUDIO_FOLDER_ID');
    expect(result.message).toContain('GOOGLE_ARCHIVE_KANTO_TRANSCRIPT_FOLDER_ID');
    expect(result.message).not.toContain('sakura-sheet');
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('a %s variable is not configured, and only that one is named', (_label, value) => {
    const env = { ...KANTO_ENV, GOOGLE_ARCHIVE_KANTO_AUDIO_FOLDER_ID: value };

    const result = resolveArchiveDestination('kanto-city-gas-demo', loadClient, env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unset: GOOGLE_ARCHIVE_KANTO_AUDIO_FOLDER_ID');
    expect(result.message).not.toContain('GOOGLE_ARCHIVE_KANTO_SHEET_ID');
  });

  test('the failure names variables, never values', () => {
    const env = { ...KANTO_ENV, GOOGLE_ARCHIVE_KANTO_SHEET_ID: '' };

    const result = resolveArchiveDestination('kanto-city-gas-demo', loadClient, env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('kanto-audio');
    expect(result.message).not.toContain('kanto-transcripts');
  });

  test('an unknown client (no client.yaml) is handled: not configured, no throw', () => {
    const result = resolveArchiveDestination('no-such-client', loadClient, {
      ...SAKURA_ENV,
      ...KANTO_ENV,
    });

    expect(result).toEqual({
      ok: false,
      message: 'archive destination not configured for no-such-client (no readable client config)',
    });
  });

  test('a path-like client id is rejected by the loader, not resolved', () => {
    const result = resolveArchiveDestination('../sakura-seikotsuin', loadClient, SAKURA_ENV);

    expect(result.ok).toBe(false);
  });

  test('a client config with no archive block fails closed', () => {
    const noArchive = (() => ({ clientId: 'legacy' })) as unknown as (id: string) => ClientConfig;

    const result = resolveArchiveDestination('legacy', noArchive, { ...SAKURA_ENV, ...KANTO_ENV });

    expect(result).toEqual({
      ok: false,
      message: 'archive destination not configured for legacy (no archive block)',
    });
  });
});
