/**
 * Cross-field rules for client.yaml — everything that needs to compare one part
 * of the file with another, and therefore cannot be expressed in the zod shape.
 *
 * Languages are data here: every rule iterates over `languages.supported`.
 * There is no language-specific branch anywhere in this file.
 */
import type { ConfigIssue } from './issues.js';
import type { ClientConfig, LocalizedText } from './schema.js';
import { KNOWN_TOP_LEVEL_KEYS, SCRIPT_KEYS } from './schema.js';

/** Placeholders our renderer (VP-2) understands. Anything else is a typo. */
export const CLINIC_PLACEHOLDERS = [
  'clinicName',
  'clinicPhone',
  'clinicAddress',
  'emergencyNumber',
] as const;

/** Only known while a call is in progress, so only valid in one of `CALLER_PLACEHOLDER_SCRIPTS`. */
export const CALLER_PLACEHOLDERS = ['callerName', 'callerPhone', 'reservationNumber'] as const;

/** The scripts that may use a caller placeholder — everywhere else, it's a typo. */
export const CALLER_PLACEHOLDER_SCRIPTS = [
  'confirmDetails',
  'confirmPhone',
  'reservationSaved',
] as const;

export const ALLOWED_PLACEHOLDERS = [...CLINIC_PLACEHOLDERS, ...CALLER_PLACEHOLDERS] as const;

/** We use `[[name]]`, not `{{ name }}`, so we never collide with Vapi's own syntax. */
const PLACEHOLDER_PATTERN = /\[\[([^\][]*)\]\]/g;

/** A block of text keyed by language code, with the path it came from. */
interface LocalizedBlock {
  path: string;
  text: LocalizedText;
}

export function collectCrossFieldIssues(
  config: ClientConfig,
  expectedClientId: string,
): ConfigIssue[] {
  return [
    ...clientIdIssues(config, expectedClientId),
    ...languageIssues(config),
    ...completenessIssues(config),
    ...faqIdIssues(config),
    ...placeholderIssues(config),
  ];
}

/** Unknown top-level keys are tolerated so new sections can be added (F-4). */
export function collectWarnings(config: ClientConfig): ConfigIssue[] {
  return Object.keys(config)
    .filter((key) => !KNOWN_TOP_LEVEL_KEYS.includes(key))
    .map((key) => ({
      path: key,
      message: 'unknown top-level section — ignored by this version of the schema',
    }));
}

function clientIdIssues(config: ClientConfig, expectedClientId: string): ConfigIssue[] {
  if (config.clientId === expectedClientId) return [];
  return [
    {
      path: 'clientId',
      message: `must match the folder name — expected "${expectedClientId}", found "${config.clientId}"`,
    },
  ];
}

function languageIssues(config: ClientConfig): ConfigIssue[] {
  const { default: defaultLanguage, supported, settings } = config.languages;
  const issues: ConfigIssue[] = [];

  if (!supported.includes(defaultLanguage)) {
    issues.push({
      path: 'languages.default',
      message: `"${defaultLanguage}" is not in languages.supported [${supported.join(', ')}]`,
    });
  }

  const duplicates = supported.filter((code, index) => supported.indexOf(code) !== index);
  for (const code of new Set(duplicates)) {
    issues.push({ path: 'languages.supported', message: `"${code}" is listed more than once` });
  }

  for (const code of supported) {
    if (!(code in settings)) {
      issues.push({
        path: `languages.settings.${code}`,
        message: `missing settings for supported language "${code}"`,
      });
    }
  }

  for (const code of Object.keys(settings)) {
    if (!supported.includes(code)) {
      issues.push({
        path: `languages.settings.${code}`,
        message: `"${code}" is not in languages.supported — add it there or remove these settings`,
      });
    }
  }

  return issues;
}

/**
 * Every localized block must carry a non-empty string for every supported
 * language, and must not carry text for a language that is not supported.
 */
function completenessIssues(config: ClientConfig): ConfigIssue[] {
  const supported = config.languages.supported;

  return localizedBlocks(config).flatMap(({ path, text }) => {
    const issues: ConfigIssue[] = [];

    for (const code of supported) {
      const value = text[code];
      if (value === undefined) {
        issues.push({
          path: `${path}.${code}`,
          message: `missing text for supported language "${code}"`,
        });
      } else if (value.trim() === '') {
        issues.push({ path: `${path}.${code}`, message: 'must not be empty' });
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
  });
}

/** Every localized block in the file, with its path. */
function localizedBlocks(config: ClientConfig): LocalizedBlock[] {
  const { postalCode: _postalCode, ...addressText } = config.business.address;

  return [
    { path: 'business.name', text: config.business.name },
    { path: 'business.address', text: addressText },
    ...SCRIPT_KEYS.map((key) => ({ path: `scripts.${key}`, text: config.scripts[key] })),
    ...config.faq.flatMap((entry, index) => [
      { path: `faq[${index}].question`, text: entry.question },
      { path: `faq[${index}].answer`, text: entry.answer },
    ]),
  ];
}

function faqIdIssues(config: ClientConfig): ConfigIssue[] {
  const seen = new Map<string, number>();

  return config.faq.flatMap((entry, index) => {
    const firstIndex = seen.get(entry.id);
    if (firstIndex === undefined) {
      seen.set(entry.id, index);
      return [];
    }
    return [
      {
        path: `faq[${index}].id`,
        message: `duplicate FAQ id "${entry.id}" — already used by faq[${firstIndex}]`,
      },
    ];
  });
}

/**
 * Placeholders are checked in scripts and FAQ text only; `business.*` holds
 * literal values, not templates.
 */
function placeholderIssues(config: ClientConfig): ConfigIssue[] {
  const scriptBlocks: LocalizedBlock[] = SCRIPT_KEYS.map((key) => ({
    path: `scripts.${key}`,
    text: config.scripts[key],
  }));
  const faqBlocks: LocalizedBlock[] = config.faq.flatMap((entry, index) => [
    { path: `faq[${index}].question`, text: entry.question },
    { path: `faq[${index}].answer`, text: entry.answer },
  ]);

  const allowedPaths = CALLER_PLACEHOLDER_SCRIPTS.map((key) => `scripts.${key}`);

  return [...scriptBlocks, ...faqBlocks].flatMap(({ path, text }) =>
    Object.entries(text).flatMap(([code, value]) =>
      checkPlaceholders(`${path}.${code}`, value, allowedPaths.includes(path)),
    ),
  );
}

function checkPlaceholders(path: string, value: string, allowCaller: boolean): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const name = (match[1] ?? '').trim();
    const isCaller = (CALLER_PLACEHOLDERS as readonly string[]).includes(name);
    const isKnown = (ALLOWED_PLACEHOLDERS as readonly string[]).includes(name);

    if (!isKnown) {
      issues.push({
        path,
        message: `unknown placeholder "[[${name}]]" — allowed: ${ALLOWED_PLACEHOLDERS.map((p) => `[[${p}]]`).join(', ')}`,
      });
      continue;
    }

    if (isCaller && !allowCaller) {
      const scriptNames = CALLER_PLACEHOLDER_SCRIPTS.map((key) => `scripts.${key}`).join(' or ');
      issues.push({
        path,
        message: `"[[${name}]]" is only allowed in ${scriptNames}`,
      });
    }
  }

  return issues;
}
