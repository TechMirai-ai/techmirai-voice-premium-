/**
 * Environment validation. Nothing else in the codebase reads process.env
 * directly (the logger's NODE_ENV check aside), so a missing variable fails
 * fast at startup with a message that says exactly what to fix.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const baseEnvSchema = z.object({
  // Required, with no default: the work order asks for an explicit environment,
  // and `.env.example` supplies it. An unset NODE_ENV in production would
  // silently turn on developer-facing error messages.
  NODE_ENV: z.enum(['development', 'test', 'production']),
  PORT: z.coerce.number().int().positive().max(65535),
  DATABASE_URL: z.string().min(1, 'is required — see .env.example'),

  // Optional for now; required from the work order that first needs them.
  TEST_DATABASE_URL: z.string().min(1).optional(),

  // Required from VP-2 onwards: the Vapi sync engine, the manual test page,
  // and the (not-yet-real) callback endpoint all need these. PUBLIC_BASE_URL
  // only needs to be a well-formed URL here — it doesn't need to actually be
  // reachable for VP-2's own tests to pass, only for a real manual test call.
  PUBLIC_BASE_URL: z.url({
    protocol: /^https?$/,
    error: 'must be a full http(s) URL, e.g. https://example.ngrok-free.app',
  }),
  VAPI_API_KEY: z.string().min(1, 'is required — see .env.example'),
  VAPI_PUBLIC_KEY: z.string().min(1, 'is required — see .env.example'),

  // Required from VP-4: the two webhooks reject every request that does not carry
  // this secret. It must equal the token of the Custom Credential created by hand
  // in the Vapi dashboard (README "Vapi webhook authentication"). Vapi's
  // credential id (`server.credentialId`) is what the sync engine puts on the tools.
  VAPI_WEBHOOK_SECRET: z.string().min(16, 'must be at least 16 characters — see .env.example'),
  VAPI_SERVER_CREDENTIAL_ID: z.string().min(1, 'is required — see .env.example'),

  // Required from VP-5: signs the staff dashboard's session cookie
  // (express-session). Longer than the webhook secret since a compromised
  // value lets an attacker forge any staff session, not just one request.
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters — see .env.example'),

  // Optional: how many reverse proxies sit in front of the server (1 behind ngrok).
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).optional(),
});

// Rate limiting keys on the client IP, which is only correct if we know how many
// proxies sit in front of us: too few makes every caller share the proxy's bucket,
// too many lets a forged X-Forwarded-For dodge the limit. So production must say.
const envSchema = baseEnvSchema.refine(
  (env) => env.NODE_ENV !== 'production' || env.TRUST_PROXY_HOPS !== undefined,
  {
    path: ['TRUST_PROXY_HOPS'],
    error: 'is required in production (0 if exposed directly, 1 behind one proxy)',
  },
);

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EnvError';
  }
}

/** Treats empty strings in .env as "not set", so optional blanks stay optional. */
function withoutBlanks(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
}

export interface LoadEnvOptions {
  /** Set to false to skip reading the .env file (tests pass values directly). */
  readDotenvFile?: boolean;
}

function parseOrThrow<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv): z.infer<T> {
  const result = schema.safeParse(withoutBlanks(source));

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvError(`Invalid environment configuration:\n${details}\n\nSee .env.example.`);
  }

  return result.data;
}

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: LoadEnvOptions = {},
): Env {
  if (options.readDotenvFile !== false) {
    loadDotenv({ quiet: true });
  }

  return parseOrThrow(envSchema, source);
}

export const isProduction = (env: Env): boolean => env.NODE_ENV === 'production';

const databaseUrlSchema = z.object({
  DATABASE_URL: z.string().min(1, 'is required — see .env.example'),
});

/**
 * A deliberately narrower load than loadEnv(): db/migrate.ts only ever needs
 * DATABASE_URL, and must keep working even in an environment that has not
 * been given Vapi credentials yet (VAPI_API_KEY/VAPI_PUBLIC_KEY/PUBLIC_BASE_URL
 * are required by loadEnv() from VP-2 onwards, but migrations have nothing to
 * do with Vapi — coupling them would make `npm run db:migrate` fail for a
 * reason unrelated to databases).
 */
export function loadDatabaseUrl(
  source: NodeJS.ProcessEnv = process.env,
  options: LoadEnvOptions = {},
): string {
  if (options.readDotenvFile !== false) {
    loadDotenv({ quiet: true });
  }

  return parseOrThrow(databaseUrlSchema, source).DATABASE_URL;
}
