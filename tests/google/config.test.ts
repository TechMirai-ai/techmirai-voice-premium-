import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { loadGoogleArchiveConfig } from '../../src/google/config.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const serviceAccount = Buffer.from(
  JSON.stringify({ client_email: 'w@p.iam.gserviceaccount.com', private_key: privateKey }),
).toString('base64');

const complete: NodeJS.ProcessEnv = {
  GOOGLE_SERVICE_ACCOUNT_JSON_B64: serviceAccount,
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'rtoken',
  ARCHIVE_RETRY_SECRET: 'x'.repeat(32),
};

describe('loadGoogleArchiveConfig', () => {
  test('returns undefined when no Google variable is set (archiving is simply off)', () => {
    expect(loadGoogleArchiveConfig({})).toBeUndefined();
    expect(loadGoogleArchiveConfig({ GOOGLE_ARCHIVE_SHEET_ID: '' })).toBeUndefined();
  });

  test('parses a complete configuration', () => {
    const config = loadGoogleArchiveConfig(complete)!;
    expect(config.serviceAccount.clientEmail).toBe('w@p.iam.gserviceaccount.com');
    expect(config.oauth).toEqual({
      clientId: 'cid',
      clientSecret: 'csecret',
      refreshToken: 'rtoken',
    });
    expect(config.retrySecret).toBe('x'.repeat(32));
  });

  test('a half-configured setup fails loudly, naming every missing variable', () => {
    const partial = { ...complete };
    delete partial.GOOGLE_OAUTH_REFRESH_TOKEN;
    delete partial.ARCHIVE_RETRY_SECRET;

    expect(() => loadGoogleArchiveConfig(partial)).toThrow(/GOOGLE_OAUTH_REFRESH_TOKEN/);
    expect(() => loadGoogleArchiveConfig(partial)).toThrow(/ARCHIVE_RETRY_SECRET/);
  });

  test('the per-client destination variables are not part of this config at all', () => {
    // GOOGLE_ARCHIVE_* are resolved per client (src/google/archiveDestination.ts), never here:
    // setting them neither enables archiving nor changes the credentials config.
    expect(loadGoogleArchiveConfig({ GOOGLE_ARCHIVE_SHEET_ID: 'sheet-1' })).toBeUndefined();
    const config = loadGoogleArchiveConfig({ ...complete, GOOGLE_ARCHIVE_SHEET_ID: 'sheet-1' })!;
    expect(Object.keys(config)).not.toContain('sheetId');
    expect(Object.keys(config)).not.toContain('audioFolderId');
    expect(Object.keys(config)).not.toContain('transcriptFolderId');
  });

  test('the error never contains a secret value', () => {
    const partial = { ...complete };
    delete partial.GOOGLE_OAUTH_REFRESH_TOKEN;
    try {
      loadGoogleArchiveConfig(partial);
      throw new Error('should have thrown');
    } catch (error) {
      const message = (error as Error).message;
      expect(message).not.toContain('csecret');
      expect(message).not.toContain(serviceAccount);
    }
  });

  test('rejects a short retry secret', () => {
    expect(() => loadGoogleArchiveConfig({ ...complete, ARCHIVE_RETRY_SECRET: 'short' })).toThrow(
      /ARCHIVE_RETRY_SECRET/,
    );
  });

  test('keeps the optional token-issue date when given', () => {
    const config = loadGoogleArchiveConfig({
      ...complete,
      GOOGLE_OAUTH_TOKEN_ISSUED_AT: '2026-10-12T00:00:00.000Z',
    })!;
    expect(config.oauth.issuedAt).toBe('2026-10-12T00:00:00.000Z');
  });
});
