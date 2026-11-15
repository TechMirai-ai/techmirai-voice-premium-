import { describe, expect, test } from 'vitest';

import { listClientIds } from '../../src/config/knownClient.js';
import { loadClient } from '../../src/config/loadClient.js';
import { parseClientConfig } from '../../src/config/schema.js';
import {
  captureIssues,
  issueAt,
  readSakuraDocument,
  SAKURA_ID,
  withChanges,
} from '../helpers/clientFixtures.js';

const sakura = readSakuraDocument();
const issuesOf = (document: unknown) =>
  captureIssues(() => parseClientConfig(document, SAKURA_ID)).issues;

describe('archive config (per-client Google archive)', () => {
  test('Sakura keeps the original variable names, so it needs no new settings', () => {
    expect(loadClient(SAKURA_ID).archive).toEqual({
      sheetIdEnv: 'GOOGLE_ARCHIVE_SHEET_ID',
      audioFolderIdEnv: 'GOOGLE_ARCHIVE_DRIVE_FOLDER_ID',
      transcriptFolderIdEnv: 'GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID',
    });
  });

  test('Kanto has its own, new variable names', () => {
    expect(loadClient('kanto-city-gas-demo').archive).toEqual({
      sheetIdEnv: 'GOOGLE_ARCHIVE_KANTO_SHEET_ID',
      audioFolderIdEnv: 'GOOGLE_ARCHIVE_KANTO_AUDIO_FOLDER_ID',
      transcriptFolderIdEnv: 'GOOGLE_ARCHIVE_KANTO_TRANSCRIPT_FOLDER_ID',
    });
  });

  test('the block is required: a client without it is a config error, not a silent default', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.archive;
    });

    expect(issueAt(issuesOf(document), 'archive')).toBeDefined();
  });

  test.each(['sheetIdEnv', 'audioFolderIdEnv', 'transcriptFolderIdEnv'])(
    '%s is required',
    (field) => {
      const document = withChanges(sakura, (draft) => {
        delete draft.archive[field];
      });

      expect(issueAt(issuesOf(document), `archive.${field}`)).toBeDefined();
    },
  );

  test.each([
    'DATABASE_URL',
    'GOOGLE_OAUTH_REFRESH_TOKEN',
    'google_archive_sheet_id',
    'GOOGLE_ARCHIVE_',
  ])('rejects %s: a name must be UPPER_SNAKE_CASE under the GOOGLE_ARCHIVE_ prefix', (name) => {
    const document = withChanges(sakura, (draft) => {
      draft.archive.sheetIdEnv = name;
    });

    expect(issueAt(issuesOf(document), 'archive.sheetIdEnv')).toContain('GOOGLE_ARCHIVE_');
  });

  test('the three names must differ from each other', () => {
    const document = withChanges(sakura, (draft) => {
      draft.archive.audioFolderIdEnv = draft.archive.sheetIdEnv;
    });

    expect(
      issuesOf(document)
        .map((issue) => issue.message)
        .join('\n'),
    ).toMatch(/three different/);
  });

  test('unknown keys inside the block are errors (a typo must not silently drop a destination)', () => {
    const document = withChanges(sakura, (draft) => {
      draft.archive.sheetId = '1AbC';
    });

    expect(issueAt(issuesOf(document), 'archive.sheetId')).toMatch(/unknown key/i);
  });

  test('NO two clients share an archive variable name (nothing is written to a shared location)', () => {
    const owners = new Map<string, string[]>();
    for (const clientId of listClientIds()) {
      const { sheetIdEnv, audioFolderIdEnv, transcriptFolderIdEnv } = loadClient(clientId).archive;
      for (const name of [sheetIdEnv, audioFolderIdEnv, transcriptFolderIdEnv]) {
        owners.set(name, [...(owners.get(name) ?? []), clientId]);
      }
    }

    const shared = [...owners].filter(([, clients]) => clients.length > 1);
    expect(shared).toEqual([]);
    expect(owners.size).toBe(listClientIds().length * 3);
  });
});
