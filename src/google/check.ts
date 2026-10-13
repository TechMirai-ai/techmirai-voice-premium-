/**
 * `npm run google:check` — proves the developer archive's Google plumbing works, and specifically
 * that the stored REFRESH token keeps working after the first access token is gone (VP-12):
 *
 *   1. Sheets: append a test row, then clear it (service account).
 *   2. Drive, first upload: mint an access token from the stored refresh token, upload, read back.
 *   3. Drive, renewal: force the cached access token to expire (simulated clock +2h), then confirm a
 *      SECOND grant with the same refresh token succeeds and a second upload works with it.
 *   4. Drive, cold start: a brand-new provider that holds nothing but the stored secrets — what a
 *      fresh serverless instance looks like — can read the first file back.
 *   5. Token age: an OAuth app left in "Testing" mode issues refresh tokens that die after 7 days.
 *      This cannot be read from Google, so the check reports the age and when to re-check.
 *
 * Test files are always deleted (even on failure). Output carries names and statuses only — never
 * a token, secret or key.
 */
import { GoogleAuthError, refreshTokenProvider, serviceAccountProvider } from './auth.js';
import type { GoogleArchiveConfig } from './config.js';
import { createDriveClient, type DriveClient } from './drive.js';
import { GoogleApiError, requestBodyText, requestUrl } from './http.js';
import { createSheetsClient, FIRST_SHEET_RANGE } from './sheets.js';

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface CheckStep {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  steps: CheckStep[];
}

export interface CheckOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const SIMULATED_ELAPSED_MS = 2 * 60 * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** Refresh tokens issued while the consent screen is in "Testing" expire after this many days. */
const TESTING_MODE_TOKEN_DAYS = 7;
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const CONSENT_HINT = 'Run `npm run google:consent` to issue a new token and folder.';

function describeFailure(error: unknown): string {
  if (error instanceof GoogleAuthError && error.reason === 'invalid_grant') {
    return `The refresh token was rejected (revoked or expired). If the OAuth consent screen is still in "Testing" mode, publish it to "In production" first. ${CONSENT_HINT}`;
  }
  if (error instanceof GoogleApiError && error.status === 404) {
    return `Drive folder not found, or not created by this OAuth client (the drive.file scope only sees folders the app created itself). ${CONSENT_HINT}`;
  }
  if (error instanceof GoogleApiError && error.status === 403) {
    return `${error.message} Check the Drive API is enabled and the consent granted the drive.file scope. ${CONSENT_HINT}`;
  }
  return error instanceof Error ? error.message : 'Unknown error.';
}

/** Wraps `fetch` to count refresh-token grants, so the check can prove how many really happened. */
function countingFetch(inner: typeof fetch, counter: { refreshGrants: number }): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit) => {
    if (
      requestUrl(input) === TOKEN_URL &&
      new URLSearchParams(requestBodyText(init)).get('grant_type') === 'refresh_token'
    ) {
      counter.refreshGrants += 1;
    }
    return inner(input, init);
  };
}

const utcDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export async function runGoogleCheck(
  config: GoogleArchiveConfig,
  options: CheckOptions = {},
): Promise<CheckResult> {
  const realNow = options.now ?? Date.now;
  const counter = { refreshGrants: 0 };
  const fetchFn = countingFetch(options.fetch ?? fetch, counter);
  let skewMs = 0;
  const skewedNow = (): number => realNow() + skewMs;

  const steps: CheckStep[] = [];
  const createdFileIds: string[] = [];
  const record = (name: string, status: CheckStatus, detail: string): void => {
    steps.push({ name, status, detail });
  };
  const run = async (name: string, action: () => Promise<string>): Promise<boolean> => {
    try {
      record(name, 'pass', await action());
      return true;
    } catch (error) {
      record(name, 'fail', describeFailure(error));
      return false;
    }
  };

  const { clientId, clientSecret, refreshToken } = config.oauth;
  const driveAuth = refreshTokenProvider({
    clientId,
    clientSecret,
    refreshToken,
    fetch: fetchFn,
    now: skewedNow,
  });
  const drive = createDriveClient(driveAuth, fetchFn);
  const stamp = new Date(realNow()).toISOString();

  const uploadAndVerify = async (
    client: DriveClient,
    label: string,
    folderId: string = config.audioFolderId,
  ): Promise<string> => {
    const bytes = new TextEncoder().encode(`google:check ${label} ${stamp}`);
    const uploaded = await client.uploadFile({
      folderId,
      name: `google-check-${label}.txt`,
      mimeType: 'text/plain',
      bytes,
    });
    createdFileIds.push(uploaded.id);
    const info = await client.getFile(uploaded.id);
    if (info.trashed || info.sizeBytes !== bytes.byteLength) {
      throw new Error('The uploaded file did not read back as expected.');
    }
    return `uploaded ${bytes.byteLength} bytes and read them back (${uploaded.link ? 'permanent link present' : 'no link'}).`;
  };

  try {
    // 1. Sheets (service account).
    const sheets = createSheetsClient(
      serviceAccountProvider({
        clientEmail: config.serviceAccount.clientEmail,
        privateKey: config.serviceAccount.privateKey,
        scopes: [SHEETS_SCOPE],
        fetch: fetchFn,
        now: realNow,
      }),
      config.sheetId,
      fetchFn,
    );
    await run('Sheets: append and clear a test row', async () => {
      const range = await sheets.appendRow(FIRST_SHEET_RANGE, ['google:check', stamp]);
      await sheets.clearRange(range);
      return `wrote and cleared ${range}.`;
    });

    // 2. Drive, first upload with a freshly minted access token.
    const firstOk = await run('Drive: first upload with a fresh token', () =>
      uploadAndVerify(drive, '1'),
    );

    // 2b. The transcript folder is a separate folder, so it needs its own proof (VP-13). It reuses
    // the cached access token, so it does not disturb the refresh-grant count below.
    await run('Drive: upload to the transcript folder', () =>
      uploadAndVerify(drive, 'transcript', config.transcriptFolderId),
    );

    // 3. Drive, forced renewal from the stored refresh token.
    let renewalOk = false;
    if (firstOk) {
      renewalOk = await run(
        'Drive: renew an expired access token from the refresh token',
        async () => {
          const grantsBefore = counter.refreshGrants;
          await driveAuth.getAccessToken(); // cached: no new grant
          skewMs += SIMULATED_ELAPSED_MS; // the one-hour access token is now long dead
          await driveAuth.getAccessToken();
          if (counter.refreshGrants !== grantsBefore + 1) {
            throw new Error('The expired access token was not renewed with a new grant.');
          }
          const uploaded = await uploadAndVerify(drive, '2');
          return `after simulating ${SIMULATED_ELAPSED_MS / 3_600_000}h of expiry, a second grant with the same refresh token succeeded; ${uploaded}`;
        },
      );
    } else {
      record(
        'Drive: renew an expired access token from the refresh token',
        'warn',
        'Skipped: the first upload failed.',
      );
    }

    // 4. Drive, cold start: nothing cached, only the stored secrets.
    let coldOk = false;
    if (firstOk && createdFileIds[0]) {
      const firstFileId = createdFileIds[0];
      coldOk = await run('Drive: cold start with only the stored secrets', async () => {
        const fresh = createDriveClient(
          refreshTokenProvider({
            clientId,
            clientSecret,
            refreshToken,
            fetch: fetchFn,
            now: realNow,
          }),
          fetchFn,
        );
        const info = await fresh.getFile(firstFileId);
        return `a brand-new provider read the first file back (${info.sizeBytes} bytes).`;
      });
    } else {
      record(
        'Drive: cold start with only the stored secrets',
        'warn',
        'Skipped: the first upload failed.',
      );
    }

    // 5. Token age — only meaningful when the Drive steps above all worked.
    if (firstOk && renewalOk && coldOk) {
      const issuedMs = config.oauth.issuedAt ? Date.parse(config.oauth.issuedAt) : Number.NaN;
      if (Number.isNaN(issuedMs)) {
        record(
          'Token age',
          'warn',
          'No GOOGLE_OAUTH_TOKEN_ISSUED_AT recorded, so a 7-day Testing-mode token cannot be ruled out. Re-run this check at least 8 days after consent.',
        );
      } else {
        const ageDays = (realNow() - issuedMs) / MS_PER_DAY;
        if (ageDays < TESTING_MODE_TOKEN_DAYS) {
          record(
            'Token age',
            'warn',
            `The refresh token is ${ageDays.toFixed(1)} days old. If the OAuth consent screen is still in "Testing" mode it will stop working after ${TESTING_MODE_TOKEN_DAYS} days. Re-run this check on or after ${utcDate(issuedMs + TESTING_MODE_TOKEN_DAYS * MS_PER_DAY)}; if it still passes, the token is long-lived.`,
          );
        } else {
          record(
            'Token age',
            'pass',
            `The refresh token is ${Math.floor(ageDays)} days old and still works, so it is not a ${TESTING_MODE_TOKEN_DAYS}-day Testing-mode token.`,
          );
        }
      }
    }
  } finally {
    // Always clean up, using the real clock so a simulated-expiry token is not reused.
    skewMs = 0;
    const failedDeletes: string[] = [];
    for (const id of createdFileIds) {
      try {
        await drive.deleteFile(id);
      } catch {
        failedDeletes.push(id);
      }
    }
    if (failedDeletes.length > 0) {
      record(
        'Cleanup',
        'warn',
        `Could not delete ${failedDeletes.length} test file(s) from the Drive folder; delete files named google-check-*.txt by hand.`,
      );
    }
  }

  return { ok: steps.every((step) => step.status !== 'fail'), steps };
}
