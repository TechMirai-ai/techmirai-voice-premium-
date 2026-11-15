/**
 * `npm run techmirai:test-sms -- <your mobile number> [--language ja|en] [--send]`
 *
 * ONE-OFF check that TechMirai's consultation SMS really reaches a phone. It runs the real
 * pipeline — the same ChannelBookingNotifier, client.yaml settings (sender "TechMirai", Japanese
 * mobiles only, daily cap), Telnyx and the delivery log — for one made-up consultation request.
 *
 *  - Without `--send` it only PREVIEWS: the SMS text, sender and a masked number. Nothing is sent
 *    and the database is not touched.
 *  - With `--send` it sends ONE real SMS (costs Telnyx credit) and writes one notification_log row
 *    that counts toward the client's daily cap. It does NOT send the LINE staff alert and does NOT
 *    save a consultation request.
 *
 * Needs migration 0017 applied (else the send reservation fails closed and nothing is sent),
 * TELNYX_API_KEY and DATABASE_URL. Never prints the number in full or any secret.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadClient } from '../config/loadClient.js';
import type { ClientConfig } from '../config/schema.js';
import { createPool } from '../db/pool.js';
import { envCredentialLookup, loadDatabaseUrl } from '../env.js';
import { normalizeCallerPhone } from '../lib/callerPhone.js';
import { ChannelBookingNotifier } from '../notifications/bookingNotifier.js';
import { consultationJob } from '../notifications/notificationJobs.js';
import { checkSmsNumber } from '../notifications/smsEligibility.js';
import { TelnyxSmsSender, type SmsMessage, type SmsSender } from '../notifications/telnyxSms.js';
import { renderTemplate } from '../notifications/template.js';
import { PgConsultationRequestRepository } from '../repositories/consultationRequestRepository.js';
import {
  PgNotificationLogRepository,
  type NotificationLogRepository,
} from '../repositories/notificationLogRepository.js';
import type { LinePusher } from '../notifications/linePush.js';

export const TEST_SMS_CLIENT_ID = 'techmirai-ai';
export const TEST_SMS_USAGE =
  'Usage: npm run techmirai:test-sms -- <your mobile number> [--language ja|en] [--send]';

export interface TestSmsDeps {
  loadConfig: (clientId: string) => ClientConfig;
  credential: (envName: string) => string | undefined;
  sms: SmsSender;
  log: NotificationLogRepository;
  consultations: PgConsultationRequestRepository;
  print: (line: string) => void;
  printError: (line: string) => void;
  now?: () => Date;
}

/** `090-****-**78`: enough to recognise your own phone, never the whole number. */
function masked(national: string): string {
  return `${national.slice(0, 3)}-****-**${national.slice(-2)}`;
}

/** Never sends LINE: the test is about the caller's SMS only. */
const NO_LINE: LinePusher = {
  push: () => Promise.reject(new Error('the test SMS never sends LINE')),
};

export async function runTestSms(argv: string[], deps: TestSmsDeps): Promise<number> {
  const send = argv.includes('--send');
  const languageIndex = argv.indexOf('--language');
  const language = languageIndex >= 0 ? (argv[languageIndex + 1] ?? '') : 'ja';
  const positionals = argv.filter(
    (arg, index) => !arg.startsWith('--') && argv[index - 1] !== '--language',
  );
  const [rawNumber] = positionals;
  if (!rawNumber || positionals.length !== 1) {
    deps.printError(TEST_SMS_USAGE);
    return 1;
  }

  const config = deps.loadConfig(TEST_SMS_CLIENT_ID);
  const sms = config.notifications?.sms;
  if (!sms?.consultationTemplates || !config.languages.supported.includes(language)) {
    deps.printError(
      `Unsupported language "${language}" or SMS not configured for ${TEST_SMS_CLIENT_ID}.`,
    );
    return 1;
  }

  const national = normalizeCallerPhone(rawNumber);
  const checked = national ? checkSmsNumber(national, sms) : undefined;
  if (!national || !checked?.to) {
    deps.printError(
      'That is not a number this client may text (a Japanese 070/080/090 mobile number). Nothing was sent.',
    );
    return 1;
  }

  const now = (deps.now ?? (() => new Date()))();
  const requestId = `test-${randomUUID()}`;
  const request = {
    clientId: TEST_SMS_CLIENT_ID,
    requestId,
    callId: `test-sms-${now.getTime()}`,
    language,
    contactName: 'TEST',
    contactPhone: national,
    phoneSource: 'spoken' as const,
    reason: null,
    createdAt: now,
  };
  const template = sms.consultationTemplates[language] ?? '';
  const text = renderTemplate(template, consultationJob(request, undefined, now).smsValues(config));

  deps.print(`To:      ${masked(national)}`);
  deps.print(`From:    ${sms.senderId}`);
  deps.print(`Text:    ${text}`);
  if (!send) {
    deps.print('');
    deps.print('Preview only — nothing was sent. Add --send to send this one SMS for real.');
    return 0;
  }

  let sentCount = 0;
  const recording: SmsSender = {
    send: async (message: SmsMessage) => {
      const result = await deps.sms.send(message);
      sentCount += 1;
      return result;
    },
  };
  const notifier = new ChannelBookingNotifier({
    // The LINE alert is switched off for this test.
    loadConfig: (clientId) => {
      const loaded = deps.loadConfig(clientId);
      const { line: _line, ...notifications } = loaded.notifications ?? {};
      return { ...loaded, notifications };
    },
    credential: deps.credential,
    sms: recording,
    line: NO_LINE,
    log: deps.log,
    consultations: deps.consultations,
    now: deps.now ?? (() => new Date()),
  });

  await notifier.notifyConsultation(request);

  if (sentCount === 1) {
    deps.print('');
    deps.print('Sent: 1 SMS handed to Telnyx. Check the phone; delivery can take a minute.');
    return 0;
  }
  deps.printError(
    'Not sent. See the notification_log row for this test call (event consultation_requested) for the reason.',
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  (async () => {
    const preview = !process.argv.includes('--send');
    // A preview needs no database; only a real send does.
    const pool = preview ? undefined : createPool({ connectionString: loadDatabaseUrl() });
    const db = pool ?? { query: () => Promise.reject(new Error('no database in preview')) };
    try {
      process.exitCode = await runTestSms(process.argv.slice(2), {
        loadConfig: (clientId) => loadClient(clientId),
        credential: envCredentialLookup(),
        sms: new TelnyxSmsSender(),
        log: new PgNotificationLogRepository(db),
        consultations: new PgConsultationRequestRepository(db),
        print: (line) => process.stdout.write(`${line}\n`),
        printError: (line) => process.stderr.write(`${line}\n`),
      });
    } finally {
      await pool?.end();
    }
  })().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
