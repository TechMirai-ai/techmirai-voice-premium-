/** Shared in-memory fixtures for the staff dashboard tests: no real Postgres needed. */
import session from 'express-session';

import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import type { VoiceRouterOptions } from '../../src/routes/voiceRouter.js';
import type {
  CallbackRequestAdminRepository,
  CallbackRequestSummary,
} from '../../src/repositories/callbackRequestRepository.js';
import type {
  NewStaffUser,
  StaffUser,
  StaffUserRepository,
} from '../../src/repositories/staffUserRepository.js';
import type { StaffRouterOptions } from '../../src/routes/staffRouter.js';

export const SESSION_SECRET = 'test-session-secret-0123456789-0123456789';
export const STAFF_CLIENT_ID = 'sakura-seikotsuin';
export const OTHER_CLIENT_ID = 'other-clinic';

let staffUserSequence = 0;

export class MemoryStaffUsers implements StaffUserRepository {
  readonly users = new Map<string, StaffUser>();

  seed(
    user: Partial<StaffUser> & { email: string; passwordHash: string; clientId: string },
  ): StaffUser {
    staffUserSequence += 1;
    const full: StaffUser = {
      id: user.id ?? `staff-${staffUserSequence}`,
      clientId: user.clientId,
      email: user.email,
      passwordHash: user.passwordHash,
      role: user.role ?? 'admin',
      mustChangePassword: user.mustChangePassword ?? true,
      createdAt: user.createdAt ?? new Date(0),
    };
    this.users.set(full.id, full);
    return full;
  }

  findByEmail(email: string): Promise<StaffUser | undefined> {
    for (const user of this.users.values()) {
      if (user.email.toLowerCase() === email.toLowerCase()) return Promise.resolve(user);
    }
    return Promise.resolve(undefined);
  }

  findById(id: string): Promise<StaffUser | undefined> {
    return Promise.resolve(this.users.get(id));
  }

  create(user: NewStaffUser): Promise<StaffUser> {
    const existing = [...this.users.values()].find(
      (candidate) => candidate.email.toLowerCase() === user.email.toLowerCase(),
    );
    if (existing) {
      const error = new Error('duplicate key value violates unique constraint') as Error & {
        code: string;
      };
      error.code = '23505';
      return Promise.reject(error);
    }
    return Promise.resolve(
      this.seed({
        clientId: user.clientId,
        email: user.email,
        passwordHash: user.passwordHash,
        ...(user.role !== undefined ? { role: user.role } : {}),
        mustChangePassword: true,
      }),
    );
  }

  completePasswordChange(id: string, passwordHash: string): Promise<void> {
    const user = this.users.get(id);
    if (!user) return Promise.resolve();
    this.users.set(id, { ...user, passwordHash, mustChangePassword: false });
    return Promise.resolve();
  }
}

export class MemoryCallbackAdmin implements CallbackRequestAdminRepository {
  readonly rows = new Map<string, CallbackRequestSummary>();

  seed(row: CallbackRequestSummary): void {
    this.rows.set(row.id, row);
  }

  listByClient(clientId: string): Promise<CallbackRequestSummary[]> {
    return Promise.resolve(
      [...this.rows.values()]
        .filter((row) => row.clientId === clientId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
    );
  }

  markHandled(id: string, clientId: string): Promise<boolean> {
    const row = this.rows.get(id);
    if (!row || row.clientId !== clientId) return Promise.resolve(false);
    this.rows.set(id, { ...row, status: 'handled', handledAt: row.handledAt ?? new Date() });
    return Promise.resolve(true);
  }
}

export function sampleCallback(
  overrides: Partial<CallbackRequestSummary> = {},
): CallbackRequestSummary {
  return {
    id: overrides.id ?? 'cb-1',
    clientId: overrides.clientId ?? STAFF_CLIENT_ID,
    callId: overrides.callId ?? 'call-1',
    language: overrides.language ?? 'ja',
    callerName: overrides.callerName ?? 'Hanako Yamada',
    callerPhone: overrides.callerPhone ?? '090-1234-5678',
    reason: overrides.reason === undefined ? 'Asked about a treatment' : overrides.reason,
    status: overrides.status ?? 'pending',
    createdAt: overrides.createdAt ?? new Date('2026-09-22T00:00:00.000Z'),
    handledAt: overrides.handledAt ?? null,
  };
}

/** Builds a real (but DB-free) StaffRouterOptions for tests that only need `staff` to satisfy AppOptions. */
export function buildStaffOptions(
  overrides: {
    staffUsers?: StaffUserRepository;
    callbacks?: CallbackRequestAdminRepository;
  } = {},
): StaffRouterOptions {
  return {
    sessionStore: new session.MemoryStore(),
    sessionSecret: SESSION_SECRET,
    isProduction: false,
    staffUsers: overrides.staffUsers ?? new MemoryStaffUsers(),
    callbacks: overrides.callbacks ?? new MemoryCallbackAdmin(),
  };
}

const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [] }) };

/**
 * A minimal, self-contained VoiceRouterOptions so buildStaffApp() can satisfy
 * createApp()'s required `voice` field without importing voiceFixtures.ts
 * (which itself imports this file, to satisfy createApp()'s `staff` field —
 * importing it back here would be circular).
 */
function minimalVoiceOptions(): VoiceRouterOptions {
  return {
    webhookSecret: 'staff-test-fixture-webhook-secret-0',
    resolver: { resolve: () => undefined },
    knowledge: new FileKnowledgeSource(),
    callbacks: { create: () => Promise.reject(new Error('not used by staff dashboard tests')) },
    topics: { record: () => Promise.reject(new Error('not used by staff dashboard tests')) },
    notifier: { notify: () => Promise.resolve() },
    services: { listByClient: () => Promise.resolve([]) },
    patients: { findByPhone: () => Promise.resolve(undefined) },
    appointments: {
      listTakenTimes: () => Promise.resolve(new Set<string>()),
      create: () => Promise.reject(new Error('not used by staff dashboard tests')),
    },
  };
}

/** Builds a full app for the staff route tests — DB-free, real HTTP via supertest. */
export function buildStaffApp(
  overrides: {
    staffUsers?: StaffUserRepository;
    callbacks?: CallbackRequestAdminRepository;
  } = {},
) {
  const staffUsers = overrides.staffUsers ?? new MemoryStaffUsers();
  const callbacks = overrides.callbacks ?? new MemoryCallbackAdmin();
  const app = createApp({
    db: healthyDb,
    isProduction: false,
    voice: minimalVoiceOptions(),
    staff: buildStaffOptions({ staffUsers, callbacks }),
  });
  return { app, staffUsers, callbacks };
}
