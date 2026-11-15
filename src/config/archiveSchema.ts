/**
 * The required `archive` section of `clients/<clientId>/client.yaml`: where this client's calls are
 * archived (one Google Sheet + two Drive folders). Like `notifications` and `transfer`, the yaml
 * holds env var NAMES, never the ids: the ids are `.env` / Vercel values.
 *
 * Names are explicit, never derived from the client id, and restricted to the `GOOGLE_ARCHIVE_`
 * prefix so a typo cannot point a client at another secret (e.g. `GOOGLE_OAUTH_REFRESH_TOKEN`).
 * The three names must differ from each other. That no two CLIENTS share a name is checked across
 * all client files in tests/config/archiveSchema.test.ts.
 *
 * Imports nothing from ./schema.ts (which imports it): see notificationsSchema.ts.
 */
import { z } from 'zod';

import { envVarName } from './envVarName.js';

export const ARCHIVE_ENV_PREFIX = 'GOOGLE_ARCHIVE_';
const archiveEnvVar = envVarName(ARCHIVE_ENV_PREFIX);

export const archiveSchema = z
  .strictObject({
    /** Env var holding the Google Sheet id (the call index). */
    sheetIdEnv: archiveEnvVar,
    /** Env var holding the Drive folder id for call audio. */
    audioFolderIdEnv: archiveEnvVar,
    /** Env var holding the Drive folder id for transcript .txt files. */
    transcriptFolderIdEnv: archiveEnvVar,
  })
  .refine(
    (archive) =>
      new Set([archive.sheetIdEnv, archive.audioFolderIdEnv, archive.transcriptFolderIdEnv])
        .size === 3,
    {
      message:
        'sheetIdEnv, audioFolderIdEnv and transcriptFolderIdEnv must be three different names',
    },
  );

export type ArchiveConfig = z.infer<typeof archiveSchema>;
