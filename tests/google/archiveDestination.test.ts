import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import type { ClientConfig } from '../../src/config/schema.js';
import { resolveArchiveDestination } from '../../src/google/archiveDestination.js';

/** The demo archive: the original variable names, shared by both demo clients. */
const DEMO_ENV = {
  GOOGLE_ARCHIVE_SHEET_ID: 'demo-sheet',
  GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: 'demo-audio',
  GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID: 'demo-transcripts',
};
const DEMO_DESTINATION = {
  sheetId: 'demo-sheet',
  audioFolderId: 'demo-audio',
  transcriptFolderId: 'demo-transcripts',
};
const REAL_ENV = {
  GOOGLE_ARCHIVE_REALCO_SHEET_ID: 'real-sheet',
  GOOGLE_ARCHIVE_REALCO_AUDIO_FOLDER_ID: 'real-audio',
  GOOGLE_ARCHIVE_REALCO_TRANSCRIPT_FOLDER_ID: 'real-transcripts',
};

/** Real yaml for the demo clients; a synthetic UNFLAGGED real client with its own variable names. */
const loader = (clientId: string): ClientConfig =>
  clientId === 'real-co'
    ? {
        ...loadClient('sakura-seikotsuin'),
        clientId,
        archive: {
          sheetIdEnv: 'GOOGLE_ARCHIVE_REALCO_SHEET_ID',
          audioFolderIdEnv: 'GOOGLE_ARCHIVE_REALCO_AUDIO_FOLDER_ID',
          transcriptFolderIdEnv: 'GOOGLE_ARCHIVE_REALCO_TRANSCRIPT_FOLDER_ID',
        },
      }
    : loadClient(clientId);

describe('resolveArchiveDestination', () => {
  test('both demo clients resolve to the SAME shared destination', () => {
    expect(resolveArchiveDestination('sakura-seikotsuin', loader, DEMO_ENV)).toEqual({
      ok: true,
      destination: DEMO_DESTINATION,
    });
    expect(resolveArchiveDestination('kanto-city-gas-demo', loader, DEMO_ENV)).toEqual({
      ok: true,
      destination: DEMO_DESTINATION,
    });
  });

  test('a real (unflagged) client resolves from ITS OWN variables, not the demo archive', () => {
    const result = resolveArchiveDestination('real-co', loader, { ...DEMO_ENV, ...REAL_ENV });

    expect(result).toEqual({
      ok: true,
      destination: {
        sheetId: 'real-sheet',
        audioFolderId: 'real-audio',
        transcriptFolderId: 'real-transcripts',
      },
    });
  });

  test('a real client whose own variables are unset fails closed even though the demo archive is set', () => {
    const result = resolveArchiveDestination('real-co', loader, DEMO_ENV);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/^archive destination not configured for real-co/);
    expect(result.message).toContain('GOOGLE_ARCHIVE_REALCO_SHEET_ID');
    expect(result.message).not.toContain('demo-sheet');
  });

  test('with no demo variables set, BOTH demo clients fail closed', () => {
    for (const clientId of ['sakura-seikotsuin', 'kanto-city-gas-demo']) {
      const result = resolveArchiveDestination(clientId, loader, {});

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.message).toContain(`archive destination not configured for ${clientId}`);
      expect(result.message).toContain('GOOGLE_ARCHIVE_SHEET_ID');
      expect(result.message).toContain('GOOGLE_ARCHIVE_DRIVE_FOLDER_ID');
      expect(result.message).toContain('GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID');
    }
  });

  test.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
  ])('a %s variable is not configured, and only that one is named', (_label, value) => {
    const env = { ...DEMO_ENV, GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: value };

    const result = resolveArchiveDestination('kanto-city-gas-demo', loader, env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('unset: GOOGLE_ARCHIVE_DRIVE_FOLDER_ID');
    expect(result.message).not.toContain('GOOGLE_ARCHIVE_SHEET_ID');
  });

  test('the failure names variables, never values', () => {
    const env = { ...DEMO_ENV, GOOGLE_ARCHIVE_SHEET_ID: '' };

    const result = resolveArchiveDestination('kanto-city-gas-demo', loader, env);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).not.toContain('demo-audio');
    expect(result.message).not.toContain('demo-transcripts');
  });

  test('an unknown client (no client.yaml) is handled: not configured, no throw', () => {
    const result = resolveArchiveDestination('no-such-client', loader, {
      ...DEMO_ENV,
      ...REAL_ENV,
    });

    expect(result).toEqual({
      ok: false,
      message: 'archive destination not configured for no-such-client (no readable client config)',
    });
  });

  test('a path-like client id is rejected by the loader, not resolved', () => {
    const result = resolveArchiveDestination('../sakura-seikotsuin', loader, DEMO_ENV);

    expect(result.ok).toBe(false);
  });

  test('a client config with no archive block fails closed', () => {
    const noArchive = (() => ({ clientId: 'legacy' })) as unknown as (id: string) => ClientConfig;

    const result = resolveArchiveDestination('legacy', noArchive, { ...DEMO_ENV, ...REAL_ENV });

    expect(result).toEqual({
      ok: false,
      message: 'archive destination not configured for legacy (no archive block)',
    });
  });
});
