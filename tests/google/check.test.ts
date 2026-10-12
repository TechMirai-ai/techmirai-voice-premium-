import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import { runGoogleCheck, type CheckStep } from '../../src/google/check.js';
import type { GoogleArchiveConfig } from '../../src/google/config.js';
import { requestBodyText, requestUrl } from '../../src/google/http.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const baseConfig: GoogleArchiveConfig = {
  serviceAccount: { clientEmail: 'w@p.iam.gserviceaccount.com', privateKey },
  sheetId: 'sheet-1',
  driveFolderId: 'folder-1',
  oauth: { clientId: 'cid', clientSecret: 'csecret', refreshToken: 'rtoken' },
  retrySecret: 'x'.repeat(32),
};

interface FakeOptions {
  /** 1-based index of the refresh-token grant that should fail with invalid_grant. */
  failRefreshNumber?: number;
  /** HTTP status to answer the upload-session request with. */
  uploadInitStatus?: number;
}

/** One fake Google: token endpoint, Sheets, and Drive, with an in-memory file store. */
function fakeGoogle(options: FakeOptions = {}) {
  const files = new Map<string, number>();
  const stats = { refreshGrants: 0, serviceAccountGrants: 0, sheetRows: 0, sheetClears: 0 };
  let nextFile = 0;
  let pendingName = '';

  const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers });

  const handle = (input: string | URL | Request, init?: RequestInit): Response => {
    const url = requestUrl(input);
    const method = init?.method ?? 'GET';

    if (url === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(requestBodyText(init));
      if (form.get('grant_type') === 'refresh_token') {
        stats.refreshGrants += 1;
        if (options.failRefreshNumber === stats.refreshGrants) {
          return json({ error: 'invalid_grant' }, 400);
        }
        return json({ access_token: `drive-at-${stats.refreshGrants}`, expires_in: 3600 });
      }
      stats.serviceAccountGrants += 1;
      return json({ access_token: `sheets-at-${stats.serviceAccountGrants}`, expires_in: 3600 });
    }
    if (url.includes(':append')) {
      stats.sheetRows += 1;
      return json({ updates: { updatedRange: 'Calls!A9:C9' } });
    }
    if (url.includes(':clear')) {
      stats.sheetClears += 1;
      return json({});
    }
    if (url.includes('uploadType=resumable')) {
      if (options.uploadInitStatus && options.uploadInitStatus !== 200) {
        return json({}, options.uploadInitStatus);
      }
      pendingName = (JSON.parse(requestBodyText(init)) as { name: string }).name;
      return json({}, 200, { location: 'https://upload.example/s' });
    }
    if (url === 'https://upload.example/s' && method === 'PUT') {
      nextFile += 1;
      const id = `file-${nextFile}`;
      files.set(id, (init?.body as Uint8Array).byteLength);
      return json({ id, webViewLink: `https://drive.example/${id}`, name: pendingName });
    }
    const fileMatch = /\/drive\/v3\/files\/(file-\d+)/.exec(url);
    if (fileMatch && method === 'GET') {
      const id = fileMatch[1]!;
      if (!files.has(id)) return json({}, 404);
      return json({
        id,
        trashed: false,
        size: String(files.get(id)),
        webViewLink: `https://d/${id}`,
      });
    }
    if (fileMatch && method === 'DELETE') {
      files.delete(fileMatch[1]!);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handle(input, init))) as typeof fetch;

  return { fetchFn, files, stats };
}

const byName = (steps: CheckStep[], name: RegExp) => steps.find((step) => name.test(step.name));

describe('runGoogleCheck', () => {
  test('passes end to end, using the stored refresh token three separate times', async () => {
    const google = fakeGoogle();

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    expect(result.ok).toBe(true);
    expect(result.steps.every((step) => step.status !== 'fail')).toBe(true);
    // first upload, forced renewal, simulated cold start — each is a separate refresh-token grant.
    expect(google.stats.refreshGrants).toBe(3);
    expect(google.stats.sheetRows).toBe(1);
    expect(google.stats.sheetClears).toBe(1);
  });

  test('forces the access token to expire and proves it is renewed from the refresh token', async () => {
    const google = fakeGoogle();

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    const renewal = byName(result.steps, /renew/i)!;
    expect(renewal.status).toBe('pass');
    expect(renewal.detail).toMatch(/second|renew/i);
  });

  test('proves a cold start works: a brand-new provider that only has the stored secret', async () => {
    const google = fakeGoogle();

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    expect(byName(result.steps, /cold start/i)?.status).toBe('pass');
  });

  test('leaves nothing behind: both test files are deleted and the test row cleared', async () => {
    const google = fakeGoogle();

    await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    expect(google.files.size).toBe(0);
  });

  test('FAILS if the renewal grant is rejected, even though the first upload worked', async () => {
    const google = fakeGoogle({ failRefreshNumber: 2 });

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    expect(result.ok).toBe(false);
    expect(byName(result.steps, /first upload/i)?.status).toBe('pass');
    expect(byName(result.steps, /renew/i)?.status).toBe('fail');
    expect(google.files.size).toBe(0); // still cleaned up
  });

  test('a revoked refresh token fails the upload with an actionable message', async () => {
    const google = fakeGoogle({ failRefreshNumber: 1 });

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    expect(result.ok).toBe(false);
    const upload = byName(result.steps, /first upload/i)!;
    expect(upload.status).toBe('fail');
    expect(upload.detail).toMatch(/google:consent/);
  });

  test('a folder the app cannot see (404) points at the consent step that creates it', async () => {
    const google = fakeGoogle({ uploadInitStatus: 404 });

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    expect(byName(result.steps, /first upload/i)?.detail).toMatch(/google:consent/);
  });

  test('never prints a secret in any step', async () => {
    const google = fakeGoogle({ failRefreshNumber: 1 });

    const result = await runGoogleCheck(baseConfig, { fetch: google.fetchFn });

    const text = JSON.stringify(result.steps);
    for (const secret of ['rtoken', 'csecret', privateKey.slice(40, 80)]) {
      expect(text).not.toContain(secret);
    }
  });

  describe('token age (a refresh token from an app still in "Testing" dies after 7 days)', () => {
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    const withIssued = (issuedAt: string): GoogleArchiveConfig => ({
      ...baseConfig,
      oauth: { ...baseConfig.oauth, issuedAt },
    });

    test('younger than 7 days: warns that a Testing-mode token cannot be ruled out yet, with the re-check date', async () => {
      const result = await runGoogleCheck(withIssued('2026-10-18T00:00:00.000Z'), {
        fetch: fakeGoogle().fetchFn,
        now: () => now,
      });

      const age = byName(result.steps, /token age/i)!;
      expect(age.status).toBe('warn');
      expect(age.detail).toContain('2026-10-25');
      expect(result.ok).toBe(true);
    });

    test('older than 7 days and still working: passes — it is not a Testing-mode token', async () => {
      const result = await runGoogleCheck(withIssued('2026-10-01T00:00:00.000Z'), {
        fetch: fakeGoogle().fetchFn,
        now: () => now,
      });

      expect(byName(result.steps, /token age/i)?.status).toBe('pass');
    });

    test('no issue date recorded: warns', async () => {
      const result = await runGoogleCheck(baseConfig, { fetch: fakeGoogle().fetchFn });
      expect(byName(result.steps, /token age/i)?.status).toBe('warn');
    });
  });
});
