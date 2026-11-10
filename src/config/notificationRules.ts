/**
 * Cross-field rules for the `notifications` section of client.yaml (VP-23).
 *
 * The caller-facing SMS is held to "strictly factual": the business name, the date and the time,
 * nothing promotional and no links (Japan's 特定電子メール法 — Act on Regulation of Transmission of
 * Specified Electronic Mail — guidance). The schema cannot enforce wording, but it can keep the
 * template to a closed list of placeholders and reject anything URL-shaped, so a careless edit to
 * a client's yaml cannot turn a confirmation into marketing.
 *
 * Languages are data: every rule iterates `languages.supported`, with no per-language branch.
 */
import type { ConfigIssue } from './issues.js';
import type { ClientConfig } from './schema.js';

/** The only placeholders the caller-facing SMS may use. */
export const SMS_PLACEHOLDERS = ['businessName', 'date', 'time'] as const;

/** Staff-facing LINE alert: internal, so it may also carry the booking's details. */
export const LINE_PLACEHOLDERS = [
  'businessName',
  'date',
  'time',
  'patientName',
  'patientPhone',
  'reservationNumber',
  'serviceName',
] as const;

/** The staff alert for a cancellation / reschedule (VP-25) also knows where the booking was before. */
export const LINE_CHANGE_PLACEHOLDERS = [...LINE_PLACEHOLDERS, 'oldDate', 'oldTime'] as const;

/** Same `[[name]]` syntax as the scripts — never `{{ }}`, which would collide with Vapi's Liquid. */
export const NOTIFICATION_PLACEHOLDER_PATTERN = /\[\[([^\][]*)\]\]/g;

/** `http://`, `https://`, `www.`, or a bare domain such as `example.com/…`. */
const URL_PATTERN = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|jp|io|co|info|biz|me)\b)/i;

export function notificationIssues(config: ClientConfig): ConfigIssue[] {
  // Staff must hear about every cancellation and reschedule: refuse a client that lets callers
  // change bookings but has no LINE alert for it — including one with no `notifications` at all.
  const missingStaffAlert =
    config.reservationFlow?.changes && !config.notifications?.line?.changeTemplates
      ? [
          {
            path: 'notifications.line.changeTemplates',
            message:
              'required when reservationFlow.changes is set — staff must be alerted to cancellations and reschedules',
          },
        ]
      : [];
  if (!config.notifications) return missingStaffAlert;
  return [...smsIssues(config), ...lineIssues(config), ...missingStaffAlert];
}

function smsIssues(config: ClientConfig): ConfigIssue[] {
  const sms = config.notifications?.sms;
  if (!sms) return [];

  return [
    ...smsTemplateSetIssues(config, 'notifications.sms.templates', sms.templates),
    // VP-25: the caller texts for a cancellation / reschedule follow the very same rules.
    ...(['cancelled', 'rescheduled'] as const).flatMap((event) =>
      sms.changeTemplates
        ? smsTemplateSetIssues(
            config,
            `notifications.sms.changeTemplates.${event}`,
            sms.changeTemplates[event],
          )
        : [],
    ),
  ];
}

/** One message per language: the default language is present, every code is supported, no links. */
function smsTemplateSetIssues(
  config: ClientConfig,
  basePath: string,
  templates: Readonly<Record<string, string>>,
): ConfigIssue[] {
  const { supported, default: defaultLanguage } = config.languages;
  const issues: ConfigIssue[] = [];

  if (!(defaultLanguage in templates)) {
    issues.push({
      path: `${basePath}.${defaultLanguage}`,
      message:
        'missing — the default language needs a template (it is the fallback for every other language)',
    });
  }

  for (const [code, text] of Object.entries(templates)) {
    const path = `${basePath}.${code}`;
    if (!supported.includes(code)) {
      issues.push({ path, message: `"${code}" is not in languages.supported` });
    }
    issues.push(...placeholderIssues(path, text, SMS_PLACEHOLDERS));
    if (URL_PATTERN.test(text)) {
      issues.push({ path, message: 'must not contain a URL or link — confirmations stay factual' });
    }
  }

  return issues;
}

function lineIssues(config: ClientConfig): ConfigIssue[] {
  const line = config.notifications?.line;
  if (!line) return [];
  const issues = placeholderIssues(
    'notifications.line.messageTemplate',
    line.messageTemplate,
    LINE_PLACEHOLDERS,
  );

  if (line.changeTemplates) {
    for (const event of ['cancelled', 'rescheduled'] as const) {
      issues.push(
        ...placeholderIssues(
          `notifications.line.changeTemplates.${event}`,
          line.changeTemplates[event],
          LINE_CHANGE_PLACEHOLDERS,
        ),
      );
    }
  }

  return issues;
}

function placeholderIssues(path: string, text: string, allowed: readonly string[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const match of text.matchAll(NOTIFICATION_PLACEHOLDER_PATTERN)) {
    const name = (match[1] ?? '').trim();
    if (!allowed.includes(name)) {
      issues.push({
        path,
        message: `unknown placeholder "[[${name}]]" — allowed: ${allowed.map((p) => `[[${p}]]`).join(', ')}`,
      });
    }
  }
  return issues;
}
