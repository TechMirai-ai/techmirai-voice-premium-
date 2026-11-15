/**
 * `npm run techmirai:test-sms -- <your mobile number> [--language ja|en] [--send]`
 *
 * ONE-OFF check that TechMirai's consultation SMS reaches a phone. It runs the real notifier —
 * client.yaml settings (sender, messaging profile, Japanese-mobile rule, the real SMS text) and the
 * real Telnyx call — for one made-up consultation request.
 *
 *  - Without `--send` it only PREVIEWS: the text, sender, profile id and a masked number. Nothing is
 *    sent.
 *  - With `--send` it sends ONE real SMS (costs Telnyx credit).
 *
 * It uses NO database: the delivery log and the cooldown source are in memory for this one run, so
 * nothing is written anywhere (migration 0017 is not needed), and the daily cap / cooldown of the
 * real system are not consulted. It does not send the LINE alert and saves no consultation request.
 * Needs TELNYX_API_KEY (from the environment or `.env`). The number is read from the command line
 * only; it is printed masked and never written to a file or log.
 */
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadClient } from '../config/loadClient.js';
import type { ClientConfig } from '../config/schema.js';
import { config as loadDotenv } from 'dotenv';

import { envCredentialLookup } from '../env.js';
import { normalizeCallerPhone } from '../lib/callerPhone.js';
import { ChannelBookingNotifier } from '../notifications/bookingNotifier.js';
import { consultationJob } from '../notifications/notificationJobs.js';
import { checkSmsNumber } from '../notifications/smsEligibility.js';
import { TelnyxSmsSender, type SmsMessage, type SmsSender } from '../notifications/telnyxSms.js';
import { renderTemplate } from '../notifications/template.js';
import type {
  NewNotificationLogEntry,
  NotificationLogRepository,
  Reservation,
  ReservedCounts,
  Settlement,
} from '../repositories/notificationLogRepository.js';
import type { LinePusher } from '../notifications/linePush.js';

export const TEST_SMS_CLIENT_ID = 'techmirai-ai';
export const TEST_SMS_USAGE =
  'Usage: npm run techmirai:test-sms -- <your mobile number> [--language ja|en] [--send]';

/** What one run records instead of the database: the outcome and Telnyx's message id, never a number. */
class RunLog implements NotificationLogRepository {
  outcome: { status: string; detail?: string; providerMessageId?: string } | undefined;
  record(entry: NewNotificationLogEntry): Promise<void> {
    this.outcome = {
      status: entry.status,
      ...(entry.detail ? { detail: entry.detail } : {}),
    };
    return Promise.resolve();
  }
  reserve(_reservation: Reservation): Promise<string> {
    return Promise.resolve('run');
  }
  settle(_id: string, settlement: Settlement): Promise<void> {
    this.outcome = {
      status: settlement.status,
      ...(settlement.detail ? { detail: settlement.detail } : {}),
      ...(settlement.providerMessageId ? { providerMessageId: settlement.providerMessageId } : {}),
    };
    return Promise.resolve();
  }
  countRecorded(): Promise<number> {
    return Promise.resolve(0);
  }
  countReserved(): Promise<ReservedCounts> {
    return Promise.resolve({ forClient: 1, forNumber: 0, forCall: 1 });
  }
}

export interface TestSmsDeps {
  loadConfig: (clientId: string) => ClientConfig;
  credential: (envName: string) => string | undefined;
  sms: SmsSender;
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
  deps.print(`Profile: ${sms.messagingProfileId}`);
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
  const log = new RunLog();
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
    log,
    now: deps.now ?? (() => new Date()),
  });

  await notifier.notifyConsultation(request);

  const { outcome } = log;
  if (sentCount === 1) {
    deps.print('');
    deps.print(
      `RESULT: SENT. Telnyx accepted 1 SMS (message id ${outcome?.providerMessageId ?? 'unknown'}).`,
    );
    deps.print('Check the phone; delivery can take a minute. Acceptance is not delivery.');
    return 0;
  }
  deps.printError('');
  deps.printError(
    `RESULT: NOT SENT. status=${outcome?.status ?? 'unknown'} reason=${outcome?.detail ?? 'unknown'}`,
  );
  deps.printError(
    'Reasons: http_<status>[_<telnyx code>] = Telnyx refused it; missing_credentials = TELNYX_API_KEY not set.',
  );
  return 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  loadDotenv({ quiet: true });
  runTestSms(process.argv.slice(2), {
    loadConfig: (clientId) => loadClient(clientId),
    credential: envCredentialLookup(),
    sms: new TelnyxSmsSender(),
    print: (line) => process.stdout.write(`${line}\n`),
    printError: (line) => process.stderr.write(`${line}\n`),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
