/**
 * Password hashing and the staff-session type augmentation (VP-5).
 *
 * Passwords are always handled here — bcrypt-compatible hashing only, never
 * a plain-string comparison, never logged (see src/lib/redact.ts and
 * CLAUDE.md: treated with the same seriousness as a caller's name/phone).
 *
 * Uses bcryptjs rather than the native `bcrypt` package: this project has not
 * decided its deployment target yet (docs/FUTURE-FEATURES.md F-8), and a
 * pure-JS implementation avoids depending on a native binding compiled for
 * whichever platform that turns out to be. Same hash format, same algorithm.
 */
import { randomBytes } from 'node:crypto';

import bcrypt from 'bcryptjs';
import { z } from 'zod';

import 'express-session';

declare module 'express-session' {
  interface SessionData {
    staffUserId?: string;
  }
}

/** Cost factor for bcrypt's hash — higher is slower and more resistant to offline guessing. */
const BCRYPT_COST_FACTOR = 12;
/** 18 random bytes -> 24 base64url characters, ~144 bits of entropy. */
const TEMPORARY_PASSWORD_BYTES = 18;

export const MIN_PASSWORD_LENGTH = 12;

export const newPasswordSchema = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`);

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * A one-time temporary password for a newly created staff account (§4.5).
 * The CLI prints this once and it is never stored anywhere except as its
 * bcrypt hash.
 */
export function generateTemporaryPassword(): string {
  return randomBytes(TEMPORARY_PASSWORD_BYTES).toString('base64url');
}
