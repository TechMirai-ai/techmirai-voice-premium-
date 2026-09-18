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
  PUBLIC_BASE_URL: z
    .url({
      protocol: /^https?$/,
      error: 'must be a full http(s) URL, e.g. https://example.ngrok-free.app',
    })
    .optional(),
  VAPI_API_KEY: z.string().min(1).optional(),
  VAPI_PUBLIC_KEY: z.string().min(1).optional(),
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

export function loadEnv(
  source: NodeJS.ProcessEnv = process.env,
  options: LoadEnvOptions = {},
): Env {
  if (options.readDotenvFile !== false) {
    loadDotenv({ quiet: true });
  }

  const result = envSchema.safeParse(withoutBlanks(source));

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new EnvError(`Invalid environment configuration:\n${details}\n\nSee .env.example.`);
  }

  return result.data;
}

export const isProduction = (env: Env): boolean => env.NODE_ENV === 'production';
