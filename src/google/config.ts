/**
 * Environment configuration for the developer archive (VP-12). All-or-nothing: with none of the
 * variables set, archiving is off and the app runs as before (so deploying before the Google setup
 * is done cannot break anything); with only some set, startup fails naming exactly what is missing —
 * a half-configured archive that silently drops calls is the failure we are guarding against.
 *
 * The refresh token is a secret like any other here: env / Vercel secret only, never committed,
 * never logged, never echoed in an error message.
 */
import { z } from 'zod';

import { parseServiceAccountJson } from './auth.js';

const REQUIRED = [
  'GOOGLE_SERVICE_ACCOUNT_JSON_B64',
  'GOOGLE_ARCHIVE_SHEET_ID',
  'GOOGLE_ARCHIVE_DRIVE_FOLDER_ID',
  'GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID',
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
  'ARCHIVE_RETRY_SECRET',
] as const;

const OPTIONAL = ['GOOGLE_OAUTH_TOKEN_ISSUED_AT'] as const;

export interface GoogleArchiveConfig {
  serviceAccount: { clientEmail: string; privateKey: string };
  sheetId: string;
  /** Drive folder for call audio (GOOGLE_ARCHIVE_DRIVE_FOLDER_ID — name kept so nothing already deployed breaks). */
  audioFolderId: string;
  /** Drive folder for transcript .txt files. */
  transcriptFolderId: string;
  oauth: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    /** ISO 8601 date the refresh token was issued; lets `google:check` reason about its age. */
    issuedAt?: string;
  };
  /** Protects the archive-retry endpoint. */
  retrySecret: string;
}

const retrySecretSchema = z.string().min(32);

function present(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = source[name];
  return value === undefined || value === '' ? undefined : value;
}

/** `undefined` when archiving is not configured at all; throws when it is configured partially. */
export function loadGoogleArchiveConfig(
  source: NodeJS.ProcessEnv = process.env,
): GoogleArchiveConfig | undefined {
  const values = Object.fromEntries(REQUIRED.map((name) => [name, present(source, name)]));
  const setCount = Object.values(values).filter((value) => value !== undefined).length;
  if (setCount === 0) return undefined;

  const missing = REQUIRED.filter((name) => values[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `Incomplete Google archive configuration — missing: ${missing.join(', ')}. ` +
        'Set all of them or none. See docs/VP12-GOOGLE-SETUP.md.',
    );
  }

  const get = (name: (typeof REQUIRED)[number]): string => values[name] as string;
  if (!retrySecretSchema.safeParse(get('ARCHIVE_RETRY_SECRET')).success) {
    throw new Error('ARCHIVE_RETRY_SECRET must be at least 32 characters.');
  }
  const issuedAt = present(source, OPTIONAL[0]);

  return {
    serviceAccount: parseServiceAccountJson(get('GOOGLE_SERVICE_ACCOUNT_JSON_B64')),
    sheetId: get('GOOGLE_ARCHIVE_SHEET_ID'),
    audioFolderId: get('GOOGLE_ARCHIVE_DRIVE_FOLDER_ID'),
    transcriptFolderId: get('GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID'),
    oauth: {
      clientId: get('GOOGLE_OAUTH_CLIENT_ID'),
      clientSecret: get('GOOGLE_OAUTH_CLIENT_SECRET'),
      refreshToken: get('GOOGLE_OAUTH_REFRESH_TOKEN'),
      ...(issuedAt ? { issuedAt } : {}),
    },
    retrySecret: get('ARCHIVE_RETRY_SECRET'),
  };
}
