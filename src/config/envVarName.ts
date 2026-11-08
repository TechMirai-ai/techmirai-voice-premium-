/**
 * `.env` variable names a client's yaml may point at (never the secret itself), upper snake case,
 * restricted to a feature's own prefix (`TELNYX_…`, `LINE_…`, `TRANSFER_…`). The value of the named
 * variable is handed to a provider or dialled, so an unrestricted name — a typo such as
 * `DATABASE_URL` — would send an unrelated secret to a third party.
 *
 * Imports nothing from ./schema.ts: the section schemas that use it are imported BY schema.ts.
 */
import { z } from 'zod';

export function envVarName(prefix: string): z.ZodString {
  return z
    .string()
    .regex(
      new RegExp(`^${prefix}[A-Z0-9_]+$`),
      `must be an UPPER_SNAKE_CASE environment variable name starting with ${prefix}`,
    );
}
