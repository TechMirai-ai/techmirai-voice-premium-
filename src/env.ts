/**
 * Environment validation. Nothing else in the codebase reads process.env
 * directly (the logger's NODE_ENV check aside), so a missing variable fails
 * fast at startup with a message that says exactly what to fix.
 */
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

const envSchema = z.object({
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
});

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
