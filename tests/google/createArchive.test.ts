import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { createArchive } from '../../src/google/createArchive.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const configured: NodeJS.ProcessEnv = {
  GOOGLE_SERVICE_ACCOUNT_JSON_B64: Buffer.from(
    JSON.stringify({ client_email: 'w@p.iam.gserviceaccount.com', private_key: privateKey }),
  ).toString('base64'),
  GOOGLE_ARCHIVE_SHEET_ID: 'sheet-1',
  GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: 'folder-1',
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'rtoken',
  ARCHIVE_RETRY_SECRET: 'r'.repeat(32),
};

const db = { query: () => Promise.resolve({ rows: [] }) };

describe('createArchive', () => {
  test('returns undefined when no Google variable is set — the app runs exactly as before', () => {
    expect(createArchive({ source: {}, db, vapiApiKey: 'k' })).toBeUndefined();
  });

  test('returns the webhook archiver and the retry endpoint deps when fully configured', () => {
    const archive = createArchive({ source: configured, db, vapiApiKey: 'k' })!;

    expect(typeof archive.reportArchiver.archiveReport).toBe('function');
    expect(archive.retry.retrySecret).toBe('r'.repeat(32));
    expect(typeof archive.retry.service.retryPending).toBe('function');
    expect(typeof archive.service.retryPending).toBe('function');
  });

  test('a half-configured archive fails at startup, naming the missing variable', () => {
    const partial = { ...configured };
    delete partial.GOOGLE_OAUTH_REFRESH_TOKEN;

    expect(() => createArchive({ source: partial, db, vapiApiKey: 'k' })).toThrow(
      /GOOGLE_OAUTH_REFRESH_TOKEN/,
    );
  });
});
