/**
 * `npm run google:consent [-- --out <file>]` — the ONE-TIME OAuth consent for the Drive audio
 * archive (VP-12, Option B). Run it on your own machine, in a browser signed in as the developer
 * Google account. Prerequisites: docs/VP12-GOOGLE-SETUP.md steps 1–4B, and the OAuth consent screen
 * published to "In production" BEFORE running this (a token issued while it is in "Testing" dies
 * after 7 days).
 *
 * It opens no browser itself: it prints a URL, waits for Google's redirect on a loopback port,
 * exchanges the code, creates the private "Call audio (private)" folder (drive.file can only see
 * folders it created itself), and writes the secrets to a 0600 file OUTSIDE the repository.
 * It prints only the folder id and the file path — never the refresh token.
 */
import { config as loadDotenv } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDriveClient } from '../google/drive.js';
import {
  DRIVE_FILE_SCOPE,
  buildConsentUrl,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  parseCallback,
} from '../google/consent.js';

const FOLDER_NAME = 'Call audio (private)';
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_OUT = path.join(homedir(), 'secrets', 'techmirai-google-oauth.env');

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

function parseOut(argv: string[]): string {
  const index = argv.indexOf('--out');
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? path.resolve(value) : DEFAULT_OUT;
}

/** Starts the loopback listener and resolves with the authorization code from Google's redirect. */
function waitForCode(
  state: string,
  onListening: (redirectUri: string) => void,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      try {
        const { code } = parseCallback(request.url ?? '/', state);
        response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Consent received. You can close this tab and return to the terminal.');
        clearTimeout(timer);
        server.close();
        resolve({ code, redirectUri });
      } catch (error) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('This request was not accepted.');
        if (!(request.url ?? '').includes('code=')) return; // e.g. a favicon request: keep waiting
        clearTimeout(timer);
        server.close();
        reject(error instanceof Error ? error : new Error('Consent callback failed.'));
      }
    });
    let redirectUri = '';
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the browser consent (5 minutes).'));
    }, CONSENT_TIMEOUT_MS);

    server.listen(0, '127.0.0.1', () => {
      redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      onListening(redirectUri);
    });
  });
}

export async function runConsent(argv: string[]): Promise<number> {
  loadDotenv({ quiet: true });
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    print(
      'Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in .env first (setup guide, step 4B).',
    );
    return 1;
  }

  const outFile = parseOut(argv);
  const state = generateState();
  const pkce = generatePkce();

  const { code, redirectUri } = await waitForCode(state, (redirect) => {
    print('1. Make sure the OAuth consent screen is published ("In production").');
    print('2. Open this URL in a browser signed in as the developer Google account:\n');
    print(
      buildConsentUrl({ clientId, redirectUri: redirect, state, codeChallenge: pkce.challenge }),
    );
    print('\nWaiting for you to approve (up to 5 minutes)…');
  });

  const tokens = await exchangeAuthorizationCode({
    clientId,
    clientSecret,
    code,
    redirectUri,
    codeVerifier: pkce.verifier,
  });
  if (tokens.grantedScope && !tokens.grantedScope.includes(DRIVE_FILE_SCOPE)) {
    print('The drive.file permission was not granted; run the consent step again and tick it.');
    return 1;
  }

  const drive = createDriveClient({ getAccessToken: () => Promise.resolve(tokens.accessToken) });
  const folderId = await drive.createFolder(FOLDER_NAME);

  mkdirSync(path.dirname(outFile), { recursive: true, mode: 0o700 });
  writeFileSync(
    outFile,
    [
      `GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refreshToken}`,
      `GOOGLE_ARCHIVE_DRIVE_FOLDER_ID=${folderId}`,
      `GOOGLE_OAUTH_TOKEN_ISSUED_AT=${new Date().toISOString()}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );

  print(`\nCreated Drive folder "${FOLDER_NAME}" — folder id: ${folderId}`);
  print(`Secrets written (not shown) to: ${outFile}`);
  print('Copy the three values from that file into your local .env and into Vercel, then run:');
  print('  npm run google:check');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runConsent(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Consent failed.'}\n`);
      process.exit(1);
    },
  );
}
