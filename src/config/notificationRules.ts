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

/** Same `[[name]]` syntax as the scripts — never `{{ }}`, which would collide with Vapi's Liquid. */
export const NOTIFICATION_PLACEHOLDER_PATTERN = /\[\[([^\][]*)\]\]/g;

/** `http://`, `https://`, `www.`, or a bare domain such as `example.com/…`. */
const URL_PATTERN = /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|jp|io|co|info|biz|me)\b)/i;

export function notificationIssues(config: ClientConfig): ConfigIssue[] {
  if (!config.notifications) return [];
  return [...smsIssues(config), ...lineIssues(config)];
}

function smsIssues(config: ClientConfig): ConfigIssue[] {
  const sms = config.notifications?.sms;
  if (!sms) return [];

  const { supported, default: defaultLanguage } = config.languages;
  const issues: ConfigIssue[] = [];

  if (!(defaultLanguage in sms.templates)) {
    issues.push({
      path: `notifications.sms.templates.${defaultLanguage}`,
      message:
        'missing — the default language needs a template (it is the fallback for every other language)',
    });
  }

  for (const [code, text] of Object.entries(sms.templates)) {
    const path = `notifications.sms.templates.${code}`;
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
  return placeholderIssues(
    'notifications.line.messageTemplate',
    line.messageTemplate,
    LINE_PLACEHOLDERS,
  );
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
