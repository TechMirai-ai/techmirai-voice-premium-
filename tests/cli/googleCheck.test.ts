import { generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runCheckCli } from '../../src/cli/googleCheck.js';
import { loadClient } from '../../src/config/loadClient.js';
import type { ArchiveDestination } from '../../src/google/archiveDestination.js';
import type { CheckResult } from '../../src/google/check.js';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const CREDENTIALS: NodeJS.ProcessEnv = {
  GOOGLE_SERVICE_ACCOUNT_JSON_B64: Buffer.from(
    JSON.stringify({ client_email: 'w@p.iam.gserviceaccount.com', private_key: privateKey }),
  ).toString('base64'),
  GOOGLE_OAUTH_CLIENT_ID: 'cid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'csecret',
  GOOGLE_OAUTH_REFRESH_TOKEN: 'rtoken',
  ARCHIVE_RETRY_SECRET: 'x'.repeat(32),
};
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
const CLIENTS = ['kanto-city-gas-demo', 'sakura-seikotsuin'];
const PASS: CheckResult = { ok: true, steps: [{ name: 's', status: 'pass', detail: 'fine' }] };

describe('google:check CLI (mocked: no Google call is ever made)', () => {
  let output = '';
  beforeEach(() => {
    output = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const run = (argv: string[], env: NodeJS.ProcessEnv) => {
    const runCheck = vi.fn((_config: unknown, _destination: ArchiveDestination) =>
      Promise.resolve(PASS),
    );
    const code = runCheckCli(argv, {
      env,
      listClients: () => CLIENTS,
      loadClientConfig: loadClient,
      runCheck,
    });
    return { code, runCheck };
  };

  test('<clientId> checks only that client, against its own Sheet and folders', async () => {
    const { code, runCheck } = run(['kanto-city-gas-demo'], {
      ...CREDENTIALS,
      ...SAKURA_ENV,
      ...KANTO_ENV,
    });

    expect(await code).toBe(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0]![1]).toEqual({
      sheetId: 'kanto-sheet',
      audioFolderId: 'kanto-audio',
      transcriptFolderId: 'kanto-transcripts',
    });
  });

  test('--all checks every client with its own destination', async () => {
    const { code, runCheck } = run(['--all'], { ...CREDENTIALS, ...SAKURA_ENV, ...KANTO_ENV });

    expect(await code).toBe(0);
    expect(runCheck.mock.calls.map(([, destination]) => destination.sheetId)).toEqual([
      'kanto-sheet',
      'sakura-sheet',
    ]);
  });

  test('a client with unset archive variables FAILS with the distinct message and gets no Google call', async () => {
    const { code, runCheck } = run(['--all'], { ...CREDENTIALS, ...SAKURA_ENV });

    expect(await code).toBe(1);
    expect(runCheck).toHaveBeenCalledTimes(1); // Sakura only
    expect(output).toContain('archive destination not configured for kanto-city-gas-demo');
    expect(output).toContain('The archive is NOT ready.');
  });

  test('--all fails if two clients point at the same Sheet or folder', async () => {
    const { code } = run(['--all'], {
      ...CREDENTIALS,
      ...SAKURA_ENV,
      ...KANTO_ENV,
      GOOGLE_ARCHIVE_KANTO_SHEET_ID: 'sakura-sheet',
    });

    expect(await code).toBe(1);
    expect(output).toContain('sheetId is shared by: kanto-city-gas-demo, sakura-seikotsuin');
  });

  test('a failing step for one client makes the whole run fail', async () => {
    const runCheck = vi.fn(() =>
      Promise.resolve<CheckResult>({
        ok: false,
        steps: [{ name: 'Sheets: header', status: 'fail', detail: 'bad header' }],
      }),
    );

    const code = await runCheckCli(['sakura-seikotsuin'], {
      env: { ...CREDENTIALS, ...SAKURA_ENV },
      listClients: () => CLIENTS,
      loadClientConfig: loadClient,
      runCheck,
    });

    expect(code).toBe(1);
    expect(output).toContain('[FAIL] Sheets: header');
  });

  test.each([[[]], [['a', 'b']], [['--all', 'sakura-seikotsuin']]])(
    'bad arguments %j print usage and make no call',
    async (argv) => {
      const { code, runCheck } = run(argv, { ...CREDENTIALS, ...SAKURA_ENV });

      expect(await code).toBe(1);
      expect(runCheck).not.toHaveBeenCalled();
      expect(output).toContain('Usage: npm run google:check');
    },
  );

  test('an unknown client id fails closed with no Google call', async () => {
    const { code, runCheck } = run(['no-such-client'], { ...CREDENTIALS, ...SAKURA_ENV });

    expect(await code).toBe(1);
    expect(runCheck).not.toHaveBeenCalled();
    expect(output).toContain('archive destination not configured for no-such-client');
  });
});
