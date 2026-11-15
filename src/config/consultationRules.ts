/**
 * Cross-field rules for the `consultation` section of client.yaml: every language is present, only
 * known placeholders are used, and the notification templates the flow depends on exist.
 *
 * Languages are data: every rule iterates `languages.supported`; nothing here names a language.
 */
import type { ConfigIssue } from './issues.js';
import type { ClientConfig } from './schema.js';
import { CONSULTATION_SCRIPT_KEYS } from './consultationSchema.js';

/** Placeholders a consultation script may use. Same `[[name]]` syntax as every other script. */
export const CONSULTATION_PLACEHOLDERS = [
  'clinicName',
  'contactHours',
  'contactEmail',
  'number',
] as const;

const PLACEHOLDER_PATTERN = /\[\[([^\][]*)\]\]/g;

function localizedIssues(
  path: string,
  text: Readonly<Record<string, string>>,
  supported: readonly string[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  for (const code of supported) {
    if (!text[code]?.trim()) {
      issues.push({
        path: `${path}.${code}`,
        message: `missing text for supported language "${code}"`,
      });
    }
  }
  for (const code of Object.keys(text)) {
    if (!supported.includes(code)) {
      issues.push({
        path: `${path}.${code}`,
        message: `"${code}" is not in languages.supported — add it there or remove this text`,
      });
    }
  }
  return issues;
}

function placeholderIssues(path: string, text: Readonly<Record<string, string>>): ConfigIssue[] {
  return Object.entries(text).flatMap(([code, value]) =>
    [...value.matchAll(PLACEHOLDER_PATTERN)]
      .map((match) => (match[1] ?? '').trim())
      .filter((name) => !(CONSULTATION_PLACEHOLDERS as readonly string[]).includes(name))
      .map((name) => ({
        path: `${path}.${code}`,
        message: `unknown placeholder "[[${name}]]" — allowed: ${CONSULTATION_PLACEHOLDERS.map((p) => `[[${p}]]`).join(', ')}`,
      })),
  );
}

export function consultationIssues(config: ClientConfig): ConfigIssue[] {
  const consultation = config.consultation;
  if (!consultation) return [];
  const { supported } = config.languages;

  const blocks: { path: string; text: Readonly<Record<string, string>> }[] = [
    { path: 'consultation.contactHours', text: consultation.contactHours },
    ...CONSULTATION_SCRIPT_KEYS.map((key) => ({
      path: `consultation.scripts.${key}`,
      text: consultation.scripts[key],
    })),
  ];

  const issues = blocks.flatMap(({ path, text }) => [
    ...localizedIssues(path, text, supported),
    // contactHours is plain text; the scripts may use placeholders.
    ...(path === 'consultation.contactHours' ? [] : placeholderIssues(path, text)),
  ]);

  // A consultation request is only useful if staff hear about it, and the caller's text needs words.
  if (config.notifications?.sms && !config.notifications.sms.consultationTemplates) {
    issues.push({
      path: 'notifications.sms.consultationTemplates',
      message: 'required when the client has consultation and SMS notifications',
    });
  }
  if (config.notifications?.line && !config.notifications.line.consultationTemplate) {
    issues.push({
      path: 'notifications.line.consultationTemplate',
      message:
        'required when the client has consultation and LINE notifications — staff must hear about every request',
    });
  }
  // Transfer is off on a consultation line; the flow tells callers so.
  if (config.transfer?.enabled) {
    issues.push({
      path: 'transfer.enabled',
      message:
        'must be off for a consultation client — the consultation flow never offers a transfer',
    });
  }
  return issues;
}
