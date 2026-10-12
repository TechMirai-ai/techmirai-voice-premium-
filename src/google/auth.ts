/**
 * Google access-token providers for the developer archive (VP-12).
 *
 *  - `refreshTokenProvider` (Drive, Option B): the secret we STORE is the long-lived OAuth *refresh*
 *    token (env/Vercel secret). Access tokens last ~1 hour and are never stored — they are minted on
 *    demand, cached in memory, and renewed slightly before they expire. A serverless instance that
 *    starts cold simply mints a fresh one. Google does not rotate refresh tokens on use, so nothing
 *    needs writing back anywhere.
 *  - `serviceAccountProvider` (Sheets): a signed JWT bearer grant, same cache.
 *
 * Plain `fetch` + `node:crypto` rather than the `googleapis` package: the surface is one token
 * endpoint plus two REST calls. Failures are typed (`GoogleAuthError`) so a dead refresh token
 * (`invalid_grant`) is reported loudly instead of looking like a generic upload error.
 * Nothing here logs, and no error message contains a secret.
 */
import { createSign } from 'node:crypto';

import { z } from 'zod';

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Renew this long before the real expiry so a token never dies mid-request. */
const EXPIRY_SAFETY_MARGIN_MS = 60_000;
const JWT_LIFETIME_SECONDS = 3600;

export type AuthFailureReason = 'invalid_grant' | 'request_failed';

export class GoogleAuthError extends Error {
  constructor(
    message: string,
    readonly reason: AuthFailureReason,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}

export interface AccessTokenProvider {
  getAccessToken(): Promise<string>;
}

export interface MintedToken {
  accessToken: string;
  expiresInSeconds: number;
}

/** Caches one access token in memory and shares a single in-flight refresh between callers. */
export class CachedTokenProvider implements AccessTokenProvider {
  private cached: { accessToken: string; expiresAtMs: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly mint: () => Promise<MintedToken>,
    private readonly now: () => number = Date.now,
  ) {}

  getAccessToken(): Promise<string> {
    const cached = this.cached;
    if (cached && this.now() < cached.expiresAtMs - EXPIRY_SAFETY_MARGIN_MS) {
      return Promise.resolve(cached.accessToken);
    }
    this.inFlight ??= this.renew().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async renew(): Promise<string> {
    const minted = await this.mint();
    this.cached = {
      accessToken: minted.accessToken,
      expiresAtMs: this.now() + minted.expiresInSeconds * 1000,
    };
    return minted.accessToken;
  }
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number(),
});

/** POSTs a form to the token endpoint and returns the minted token, or throws a typed error. */
async function requestToken(
  fetchFn: typeof fetch,
  form: Record<string, string>,
): Promise<MintedToken> {
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    });
  } catch {
    throw new GoogleAuthError('Google token request failed (network error).', 'request_failed');
  }

  const body: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const code = z.object({ error: z.string() }).safeParse(body);
    if (code.success && code.data.error === 'invalid_grant') {
      throw new GoogleAuthError(
        'Google rejected the credential as invalid_grant: it was revoked or has expired. ' +
          'Re-run the consent step to issue a new refresh token.',
        'invalid_grant',
      );
    }
    throw new GoogleAuthError(
      `Google token request failed with HTTP ${response.status}.`,
      'request_failed',
    );
  }

  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new GoogleAuthError(
      'Google token response was not in the expected shape.',
      'request_failed',
    );
  }
  return { accessToken: parsed.data.access_token, expiresInSeconds: parsed.data.expires_in };
}

export interface ProviderOptions {
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Injected in tests; defaults to `Date.now`. */
  now?: () => number;
}

export interface RefreshTokenOptions extends ProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

export function refreshTokenProvider(options: RefreshTokenOptions): AccessTokenProvider {
  const fetchFn = options.fetch ?? fetch;
  return new CachedTokenProvider(
    () =>
      requestToken(fetchFn, {
        grant_type: 'refresh_token',
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
      }),
    options.now,
  );
}

export interface ServiceAccountOptions extends ProviderOptions {
  clientEmail: string;
  privateKey: string;
  scopes: readonly string[];
}

const base64url = (value: string): string => Buffer.from(value).toString('base64url');

function signJwt(options: ServiceAccountOptions, nowMs: number): string {
  const issuedAt = Math.floor(nowMs / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      iss: options.clientEmail,
      scope: options.scopes.join(' '),
      aud: GOOGLE_TOKEN_URL,
      iat: issuedAt,
      exp: issuedAt + JWT_LIFETIME_SECONDS,
    }),
  );
  const signature = createSign('RSA-SHA256')
    .update(`${header}.${payload}`)
    .sign(options.privateKey)
    .toString('base64url');
  return `${header}.${payload}.${signature}`;
}

export function serviceAccountProvider(options: ServiceAccountOptions): AccessTokenProvider {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  return new CachedTokenProvider(
    () =>
      requestToken(fetchFn, {
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signJwt(options, now()),
      }),
    now,
  );
}

const serviceAccountKeySchema = z.object({
  client_email: z.string().min(1),
  private_key: z.string().min(1),
});

/** Reads the `GOOGLE_SERVICE_ACCOUNT_JSON_B64` env value (the base64 of Google's key file). */
export function parseServiceAccountJson(base64: string): {
  clientEmail: string;
  privateKey: string;
} {
  const fail = (): never => {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not the base64 of a service-account key file ' +
        '(it needs client_email and private_key). See docs/VP12-GOOGLE-SETUP.md.',
    );
  };
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  } catch {
    return fail();
  }
  const parsed = serviceAccountKeySchema.safeParse(json);
  if (!parsed.success) return fail();
  return { clientEmail: parsed.data.client_email, privateKey: parsed.data.private_key };
}
