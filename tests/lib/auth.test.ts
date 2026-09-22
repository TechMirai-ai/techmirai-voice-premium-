import { describe, expect, test } from 'vitest';

import {
  generateTemporaryPassword,
  hashPassword,
  MIN_PASSWORD_LENGTH,
  newPasswordSchema,
  verifyPassword,
} from '../../src/lib/auth.js';

describe('hashPassword / verifyPassword', () => {
  test('a hashed password verifies against the same plaintext', async () => {
    const hash = await hashPassword('a-real-password-123');

    expect(await verifyPassword('a-real-password-123', hash)).toBe(true);
  });

  test('verification fails for the wrong password', async () => {
    const hash = await hashPassword('a-real-password-123');

    expect(await verifyPassword('a-different-password', hash)).toBe(false);
  });

  test('the stored hash is never the plaintext password', async () => {
    const hash = await hashPassword('a-real-password-123');

    expect(hash).not.toBe('a-real-password-123');
    expect(hash).not.toContain('a-real-password-123');
  });

  test('hashing the same password twice gives two different hashes (random salt)', async () => {
    const [first, second] = await Promise.all([
      hashPassword('same-password-value'),
      hashPassword('same-password-value'),
    ]);

    expect(first).not.toBe(second);
  });
});

describe('generateTemporaryPassword', () => {
  test('generates a sufficiently long, non-empty password', () => {
    const password = generateTemporaryPassword();

    expect(password.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
  });

  test('generates a different value each call', () => {
    expect(generateTemporaryPassword()).not.toBe(generateTemporaryPassword());
  });

  test('satisfies the new-password schema used at change-password time', () => {
    expect(newPasswordSchema.safeParse(generateTemporaryPassword()).success).toBe(true);
  });
});

describe('newPasswordSchema', () => {
  test('rejects a password shorter than the minimum length', () => {
    expect(newPasswordSchema.safeParse('short').success).toBe(false);
  });

  test('accepts a password at exactly the minimum length', () => {
    expect(newPasswordSchema.safeParse('x'.repeat(MIN_PASSWORD_LENGTH)).success).toBe(true);
  });
});
