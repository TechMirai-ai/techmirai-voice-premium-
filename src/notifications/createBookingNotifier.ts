/**
 * Builds the production booking notifier. The one place the real pieces are put together —
 * client.yaml loading, env-var credentials, Telnyx, LINE and the Postgres delivery log — so
 * api/index.ts (Vercel) and src/server.ts (local) stay a single line each.
 */
import { loadClient } from '../config/loadClient.js';
import type { Queryable } from '../db/pool.js';
import { envCredentialLookup } from '../env.js';
import { PgNotificationLogRepository } from '../repositories/notificationLogRepository.js';
import { ChannelBookingNotifier, type BookingNotifier } from './bookingNotifier.js';
import { LineMessagingPusher } from './linePush.js';
import { TelnyxSmsSender } from './telnyxSms.js';

export function createBookingNotifier(db: Queryable): BookingNotifier {
  return new ChannelBookingNotifier({
    loadConfig: (clientId) => loadClient(clientId),
    credential: envCredentialLookup(),
    sms: new TelnyxSmsSender(),
    line: new LineMessagingPusher(),
    log: new PgNotificationLogRepository(db),
  });
}
