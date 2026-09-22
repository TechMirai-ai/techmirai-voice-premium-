import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { runCreateStaffUser } from '../../src/cli/createStaffUser.js';
import { verifyPassword } from '../../src/lib/auth.js';
import { buildLogRecord } from '../../src/lib/logger.js';
import { MemoryStaffUsers } from '../helpers/staffFixtures.js';

describe('runCreateStaffUser', () => {
  let stdout: string[];
  let stderr: string[];

  beforeEach(() => {
    stdout = [];
    stderr = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('creates a working login with must_change_password true, hash verifies, and prints the temporary password once', async () => {
    const staffUsers = new MemoryStaffUsers();

    const code = await runCreateStaffUser(['owner@example.com', 'sakura-seikotsuin'], {
      staffUsers,
    });

    expect(code).toBe(0);
    const created = await staffUsers.findByEmail('owner@example.com');
    expect(created).toBeDefined();
    expect(created?.clientId).toBe('sakura-seikotsuin');
    expect(created?.mustChangePassword).toBe(true);

    const printed = stdout.join('');
    const match = /Temporary password.*:\n\s+(\S+)/s.exec(printed);
    const temporaryPassword = match?.[1];
    expect(temporaryPassword).toBeTruthy();
    expect(await verifyPassword(temporaryPassword ?? '', created?.passwordHash ?? '')).toBe(true);
  });

  test('rejects a duplicate email and creates no second row', async () => {
    const staffUsers = new MemoryStaffUsers();
    await runCreateStaffUser(['owner@example.com', 'sakura-seikotsuin'], { staffUsers });

    const code = await runCreateStaffUser(['owner@example.com', 'sakura-seikotsuin'], {
      staffUsers,
    });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('already exists');
    expect(staffUsers.users.size).toBe(1);
  });

  test('prints usage and fails when arguments are missing', async () => {
    const staffUsers = new MemoryStaffUsers();

    const code = await runCreateStaffUser([], { staffUsers });

    expect(code).toBe(1);
    expect(stderr.join('')).toContain('Usage:');
    expect(staffUsers.users.size).toBe(0);
  });

  test('the temporary password never appears in redacted log output', async () => {
    const staffUsers = new MemoryStaffUsers();

    await runCreateStaffUser(['owner@example.com', 'sakura-seikotsuin'], { staffUsers });

    const printed = stdout.join('');
    const match = /Temporary password.*:\n\s+(\S+)/s.exec(printed);
    const temporaryPassword = match?.[1];
    expect(temporaryPassword).toBeTruthy();

    // Simulate the temporary password flowing into a log call the way any
    // other part of the codebase would — it must come out masked.
    const record = buildLogRecord('info', 'staff account created', {
      temporaryPassword,
      passwordHash: 'irrelevant-hash-value',
    });
    expect(JSON.stringify(record)).not.toContain(temporaryPassword);
  });
});
