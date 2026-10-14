/**
 * Vercel serverless entry point. Mirrors src/server.ts's env/pool/repository
 * wiring, but exports a request handler instead of calling .listen() —
 * Vercel owns the HTTP server and invokes this per request. Module-scope
 * values (pool, app) are created once per lambda instance and reused across
 * warm invocations, same lifecycle as any Node server, just without the
 * listen/shutdown calls that only make sense for a process we control.
 */
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { createApp } from '../src/app.js';
import { clinicTimeZoneLookup } from '../src/config/clinicTimeZone.js';
import { createPool } from '../src/db/pool.js';
import { createArchive } from '../src/google/createArchive.js';
import { isProduction, loadEnv } from '../src/env.js';
import { LoggingNotifier } from '../src/lib/callbackNotifier.js';
import { logger } from '../src/lib/logger.js';
import { FileKnowledgeSource } from '../src/knowledge/KnowledgeSource.js';
import { PgAppointmentRepository } from '../src/repositories/appointmentRepository.js';
import { PgCallbackRequestRepository } from '../src/repositories/callbackRequestRepository.js';
import { PgCallLogRepository } from '../src/repositories/callLogRepository.js';
import { PgCallTopicRepository } from '../src/repositories/callTopicRepository.js';
import { PgReservationPatientRepository } from '../src/repositories/reservationPatientRepository.js';
import { PgReservationServiceRepository } from '../src/repositories/reservationServiceRepository.js';
import { PgStaffUserRepository } from '../src/repositories/staffUserRepository.js';
import { StateFileAssistantResolver } from '../src/vapi/assistantResolver.js';

const env = loadEnv();
const pool = createPool({ connectionString: env.DATABASE_URL });
const callbacks = new PgCallbackRequestRepository(pool);
// VP-12: the developer archive (Google). Undefined until the GOOGLE_* variables are set.
const archive = createArchive({ db: pool, vapiApiKey: env.VAPI_API_KEY });
const PgSession = connectPgSimple(session);

const app = createApp({
  db: pool,
  isProduction: isProduction(env),
  ...(env.TRUST_PROXY_HOPS !== undefined ? { trustProxyHops: env.TRUST_PROXY_HOPS } : {}),
  voice: {
    webhookSecret: env.VAPI_WEBHOOK_SECRET,
    resolver: new StateFileAssistantResolver(),
    knowledge: new FileKnowledgeSource(),
    callbacks,
    topics: new PgCallTopicRepository(pool),
    // VP-12: staff summary/status row written from the end-of-call-report.
    callLogs: new PgCallLogRepository(pool),
    ...(archive ? { archive: archive.reportArchiver } : {}),
    // F-2: email/LINE are new classes implementing CallbackNotifier, swapped in here.
    notifier: new LoggingNotifier(),
    // VP-8 demo reservation feature.
    appointments: new PgAppointmentRepository(pool),
    patients: new PgReservationPatientRepository(pool),
    services: new PgReservationServiceRepository(pool),
  },
  ...(archive ? { archiveRetry: archive.retry } : {}),
  staff: {
    sessionStore: new PgSession({
      pool,
      tableName: 'session',
      errorLog: (...args: unknown[]) =>
        logger.error('session store error', { detail: args.map(String).join(' ') }),
    }),
    sessionSecret: env.SESSION_SECRET,
    staffUsers: new PgStaffUserRepository(pool),
    callbacks,
    callLogs: new PgCallLogRepository(pool),
    timeZoneFor: clinicTimeZoneLookup(),
  },
  talk: {
    publicKey: env.VAPI_PUBLIC_KEY,
    rateLimitSecret: env.TALK_RATE_LIMIT_SECRET,
    bypassKey: env.TALK_BYPASS_KEY,
    isProduction: isProduction(env),
    callLogs: new PgCallLogRepository(pool),
  },
});

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req, res);
}
