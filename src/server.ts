/** Starts the HTTP server. All wiring of env → pool → app happens here. */
import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';

import { createApp } from './app.js';
import { createPool } from './db/pool.js';
import { isProduction, loadEnv } from './env.js';
import { LoggingNotifier } from './lib/callbackNotifier.js';
import { logger } from './lib/logger.js';
import { FileKnowledgeSource } from './knowledge/KnowledgeSource.js';
import { PgAppointmentRepository } from './repositories/appointmentRepository.js';
import { PgCallbackRequestRepository } from './repositories/callbackRequestRepository.js';
import { PgCallTopicRepository } from './repositories/callTopicRepository.js';
import { PgReservationPatientRepository } from './repositories/reservationPatientRepository.js';
import { PgReservationServiceRepository } from './repositories/reservationServiceRepository.js';
import { PgStaffUserRepository } from './repositories/staffUserRepository.js';
import { StateFileAssistantResolver } from './vapi/assistantResolver.js';

const env = loadEnv();
const pool = createPool({ connectionString: env.DATABASE_URL });
const callbacks = new PgCallbackRequestRepository(pool);
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
    // F-2: email/LINE are new classes implementing CallbackNotifier, swapped in here.
    notifier: new LoggingNotifier(),
    // VP-8 demo reservation feature.
    appointments: new PgAppointmentRepository(pool),
    patients: new PgReservationPatientRepository(pool),
    services: new PgReservationServiceRepository(pool),
  },
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
  },
});

const server = app.listen(env.PORT, () => {
  logger.info('server listening', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
