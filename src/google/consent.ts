/**
 * One-time OAuth consent for the Drive audio archive (VP-12, Option B), pure parts only — the local
 * loopback server that receives the redirect lives in `src/cli/googleConsent.ts`.
 *
 * Why this shape:
 *  - Scope is `drive.file`, not `drive`: the issued token can only touch files and folders THIS app
 *    created, so a leaked token cannot read the rest of the developer's Drive. The consent script
 *    therefore creates the archive folder itself.
 *  - `access_type=offline` + `prompt=consent` makes Google issue a refresh token every time.
 *  - PKCE (S256) and a random `state` protect the loopback redirect.
 *  - The consent screen MUST be published to "In production" first; refresh tokens from an app left
 *    in "Testing" expire after 7 days (see docs/VP12-GOOGLE-SETUP.md).
 */
import { createHash, randomBytes } from 'node:crypto';

import { z } from 'zod';

import { GOOGLE_TOKEN_URL } from './auth.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const PKCE_VERIFIER_BYTES = 48;

export interface ConsentUrlInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export function buildConsentUrl(input: ConsentUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: DRIVE_FILE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(PKCE_VERIFIER_BYTES).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

export function generateState(): string {
  return randomBytes(24).toString('base64url');
}

/** Reads the loopback redirect's request path (`/?code=…&state=…`). Throws a readable error. */
export function parseCallback(requestPath: string, expectedState: string): { code: string } {
  const params = new URL(requestPath, 'http://127.0.0.1').searchParams;
  if (params.get('state') !== expectedState) {
    throw new Error(
      'The redirect had the wrong state value; ignoring it (possible forged request).',
    );
  }
  const error = params.get('error');
  if (error) {
    throw new Error(`Google reported "${error}" — consent was denied or failed.`);
  }
  const code = params.get('code');
  if (!code) throw new Error('The redirect carried no authorization code.');
  return { code };
}

export interface ExchangeInput {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  fetch?: typeof fetch;
}

const exchangeSchema = z.object({
  refresh_token: z.string().min(1).optional(),
  access_token: z.string().min(1),
  scope: z.string().optional(),
});

export interface ConsentTokens {
  refreshToken: string;
  accessToken: string;
  grantedScope: string | undefined;
}

export async function exchangeAuthorizationCode(input: ExchangeInput): Promise<ConsentTokens> {
  const fetchFn = input.fetch ?? fetch;
  const response = await fetchFn(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
    }).toString(),
  });

  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    throw new Error(
      `Google rejected the authorization code (HTTP ${response.status}). Start again.`,
    );
  }
  const parsed = exchangeSchema.safeParse(body);
  if (!parsed.success) throw new Error('Google returned an unexpected token response.');
  if (!parsed.data.refresh_token) {
    throw new Error(
      'Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and run the consent step again.',
    );
  }
  return {
    refreshToken: parsed.data.refresh_token,
    accessToken: parsed.data.access_token,
    grantedScope: parsed.data.scope,
  };
}
