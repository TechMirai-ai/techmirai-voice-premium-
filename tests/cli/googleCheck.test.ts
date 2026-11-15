import { generateKeyPairSync } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runCheckCli } from '../../src/cli/googleCheck.js';
import { loadClient } from '../../src/config/loadClient.js';
import type { ClientConfig } from '../../src/config/schema.js';
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
/** The demo archive: the original variable names, shared by both demo clients. */
const DEMO_ENV = {
  GOOGLE_ARCHIVE_SHEET_ID: 'demo-sheet',
  GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: 'demo-audio',
  GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID: 'demo-transcripts',
};
const REAL_ENV = {
  GOOGLE_ARCHIVE_REALCO_SHEET_ID: 'real-sheet',
  GOOGLE_ARCHIVE_REALCO_AUDIO_FOLDER_ID: 'real-audio',
  GOOGLE_ARCHIVE_REALCO_TRANSCRIPT_FOLDER_ID: 'real-transcripts',
};
const DEMO_CLIENTS = ['kanto-city-gas-demo', 'sakura-seikotsuin'];
const PASS: CheckResult = { ok: true, steps: [{ name: 's', status: 'pass', detail: 'fine' }] };

type Loader = (clientId: string) => ClientConfig;

/** Real yaml, except `real-co` (synthetic, unflagged, its own variable names) and optional overrides. */
function loaderWith(options: { unflag?: string[] } = {}): Loader {
  return (clientId) => {
    if (clientId === 'real-co') {
      return {
        ...loadClient('sakura-seikotsuin'),
        clientId,
        archive: {
          sheetIdEnv: 'GOOGLE_ARCHIVE_REALCO_SHEET_ID',
          audioFolderIdEnv: 'GOOGLE_ARCHIVE_REALCO_AUDIO_FOLDER_ID',
          transcriptFolderIdEnv: 'GOOGLE_ARCHIVE_REALCO_TRANSCRIPT_FOLDER_ID',
        },
      };
    }
    const config = loadClient(clientId);
    if (!options.unflag?.includes(clientId)) return config;
    const { sharedDemoArchive: _flag, ...archive } = config.archive;
    return { ...config, archive };
  };
}

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

  const run = (
    argv: string[],
    env: NodeJS.ProcessEnv,
    options: { clients?: string[]; loader?: Loader } = {},
  ) => {
    const runCheck = vi.fn((_config: unknown, _destination: ArchiveDestination) =>
      Promise.resolve(PASS),
    );
    const code = runCheckCli(argv, {
      env,
      listClients: () => options.clients ?? DEMO_CLIENTS,
      loadClientConfig: options.loader ?? loaderWith(),
      runCheck,
    });
    return { code, runCheck };
  };

  test('<clientId> checks that client against the destination its archive block names', async () => {
    const { code, runCheck } = run(['kanto-city-gas-demo'], { ...CREDENTIALS, ...DEMO_ENV });

    expect(await code).toBe(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0]![1]).toEqual({
      sheetId: 'demo-sheet',
      audioFolderId: 'demo-audio',
      transcriptFolderId: 'demo-transcripts',
    });
  });

  test('--all: the two flagged demo clients sharing passes, as an INFO line, and the shared destination is checked ONCE', async () => {
    const { code, runCheck } = run(['--all'], { ...CREDENTIALS, ...DEMO_ENV });

    expect(await code).toBe(0);
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(output).toContain(
      '[INFO] shared by demo clients: kanto-city-gas-demo, sakura-seikotsuin',
    );
    expect(output).toContain(
      'kanto-city-gas-demo, sakura-seikotsuin (shared destination, checked once)',
    );
    expect(output).not.toContain('[FAIL]');
    expect(output).toContain('All checks passed');
  });

  test('--all: a real client with its own destination is checked separately, and does not trigger sharing output', async () => {
    const { code, runCheck } = run(
      ['--all'],
      { ...CREDENTIALS, ...DEMO_ENV, ...REAL_ENV },
      { clients: [...DEMO_CLIENTS, 'real-co'] },
    );

    expect(await code).toBe(0);
    expect(runCheck.mock.calls.map(([, destination]) => destination.sheetId).sort()).toEqual([
      'demo-sheet',
      'real-sheet',
    ]);
    expect(output).not.toContain('real-co (shared');
    expect(output).not.toMatch(/\[INFO\].*real-co/);
  });

  test('--all: a flagged and an UNFLAGGED client sharing the same archive FAILS', async () => {
    const { code } = run(
      ['--all'],
      { ...CREDENTIALS, ...DEMO_ENV },
      {
        loader: loaderWith({ unflag: ['kanto-city-gas-demo'] }),
      },
    );

    expect(await code).toBe(1);
    expect(output).toContain('[FAIL] kanto-city-gas-demo, sakura-seikotsuin share');
    expect(output).toContain('sharedDemoArchive');
    expect(output).not.toContain('[INFO] shared by demo clients');
    expect(output).toContain('The archive is NOT ready.');
  });

  test('--all: two UNFLAGGED clients sharing the same archive FAILS', async () => {
    const { code } = run(
      ['--all'],
      { ...CREDENTIALS, ...DEMO_ENV },
      {
        loader: loaderWith({ unflag: DEMO_CLIENTS }),
      },
    );

    expect(await code).toBe(1);
    expect(output).toContain('[FAIL] kanto-city-gas-demo, sakura-seikotsuin share');
  });

  test('--all: an unflagged client whose variables merely RESOLVE to the demo ids still FAILS (id-level check)', async () => {
    const { code } = run(
      ['--all'],
      {
        ...CREDENTIALS,
        ...DEMO_ENV,
        GOOGLE_ARCHIVE_REALCO_SHEET_ID: 'demo-sheet',
        GOOGLE_ARCHIVE_REALCO_AUDIO_FOLDER_ID: 'demo-audio',
        GOOGLE_ARCHIVE_REALCO_TRANSCRIPT_FOLDER_ID: 'demo-transcripts',
      },
      { clients: [...DEMO_CLIENTS, 'real-co'] },
    );

    expect(await code).toBe(1);
    expect(output).toContain('real-co');
    expect(output).toContain('[FAIL]');
    expect(output).toContain('sheetId');
  });

  test('--all: clients with unset archive variables FAIL with the distinct message and get no Google call', async () => {
    const { code, runCheck } = run(['--all'], { ...CREDENTIALS });

    expect(await code).toBe(1);
    expect(runCheck).not.toHaveBeenCalled();
    expect(output).toContain('archive destination not configured for kanto-city-gas-demo');
    expect(output).toContain('archive destination not configured for sakura-seikotsuin');
    expect(output).toContain('The archive is NOT ready.');
  });

  test('a failing step makes the whole run fail', async () => {
    const runCheck = vi.fn(() =>
      Promise.resolve<CheckResult>({
        ok: false,
        steps: [{ name: 'Sheets: header', status: 'fail', detail: 'bad header' }],
      }),
    );

    const code = await runCheckCli(['sakura-seikotsuin'], {
      env: { ...CREDENTIALS, ...DEMO_ENV },
      listClients: () => DEMO_CLIENTS,
      loadClientConfig: loaderWith(),
      runCheck,
    });

    expect(code).toBe(1);
    expect(output).toContain('[FAIL] Sheets: header');
  });

  test.each([[[]], [['a', 'b']], [['--all', 'sakura-seikotsuin']]])(
    'bad arguments %j print usage and make no call',
    async (argv) => {
      const { code, runCheck } = run(argv, { ...CREDENTIALS, ...DEMO_ENV });

      expect(await code).toBe(1);
      expect(runCheck).not.toHaveBeenCalled();
      expect(output).toContain('Usage: npm run google:check');
    },
  );

  test('an unknown client id fails closed with no Google call', async () => {
    const { code, runCheck } = run(['no-such-client'], { ...CREDENTIALS, ...DEMO_ENV });

    expect(await code).toBe(1);
    expect(runCheck).not.toHaveBeenCalled();
    expect(output).toContain('archive destination not configured for no-such-client');
  });
});
