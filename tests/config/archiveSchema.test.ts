import { describe, expect, test } from 'vitest';

import { analyzeSharing } from '../../src/config/archiveSharing.js';
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
      sharedDemoArchive: true,
    });
  });

  test('both demo clients share the existing demo archive, and both say so explicitly', () => {
    const sakuraArchive = loadClient(SAKURA_ID).archive;
    const kantoArchive = loadClient('kanto-city-gas-demo').archive;

    expect(kantoArchive).toEqual(sakuraArchive);
    expect(sakuraArchive.sharedDemoArchive).toBe(true);
    expect(kantoArchive.sharedDemoArchive).toBe(true);
  });

  test('sharedDemoArchive accepts only true (a "false" flag would be a confusing second way to say "not shared")', () => {
    const accepted = withChanges(sakura, (draft) => {
      draft.archive.sharedDemoArchive = true;
    });
    expect(() => parseClientConfig(accepted, SAKURA_ID)).not.toThrow();

    const unflagged = withChanges(sakura, (draft) => {
      delete draft.archive.sharedDemoArchive;
    });
    expect(() => parseClientConfig(unflagged, SAKURA_ID)).not.toThrow();

    const rejected = withChanges(sakura, (draft) => {
      draft.archive.sharedDemoArchive = false;
    });
    expect(issueAt(issuesOf(rejected), 'archive.sharedDemoArchive')).toBeDefined();
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

  test('across ALL real clients, an archive variable name is shared only between clients that all carry sharedDemoArchive', () => {
    const entries = listClientIds().map((clientId) => {
      const { sheetIdEnv, audioFolderIdEnv, transcriptFolderIdEnv, sharedDemoArchive } =
        loadClient(clientId).archive;
      return {
        clientId,
        shared: sharedDemoArchive === true,
        keys: [sheetIdEnv, audioFolderIdEnv, transcriptFolderIdEnv],
      };
    });

    const { conflicts, sharedByDemo } = analyzeSharing(entries);

    expect(conflicts).toEqual([]);
    // The only sharing that exists is the two demo clients.
    for (const group of sharedByDemo) {
      expect(group.clients).toEqual(['kanto-city-gas-demo', 'sakura-seikotsuin']);
    }
  });
});
