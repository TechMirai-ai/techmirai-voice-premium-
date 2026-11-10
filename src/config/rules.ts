/**
 * Cross-field rules for client.yaml — everything that needs to compare one part
 * of the file with another, and therefore cannot be expressed in the zod shape.
 *
 * Languages are data here: every rule iterates over `languages.supported`.
 * There is no language-specific branch anywhere in this file.
 */
import type { ConfigIssue } from './issues.js';
import { notificationIssues } from './notificationRules.js';
import type { ClientConfig, LocalizedText } from './schema.js';
import { KNOWN_TOP_LEVEL_KEYS, SCRIPT_KEYS } from './schema.js';
import { transferIssues } from './transferRules.js';
import { TRANSFER_SCRIPT_KEYS } from './transferSchema.js';

/** Placeholders our renderer (VP-2) understands. Anything else is a typo. */
export const CLINIC_PLACEHOLDERS = ['clinicName', 'clinicPhone', 'clinicAddress'] as const;

/** Only known while a call is in progress, so only valid in one of `CALLER_PLACEHOLDER_SCRIPTS`. */
export const CALLER_PLACEHOLDERS = ['callerName', 'reservationNumber'] as const;

/** The scripts that may use a caller placeholder — everywhere else, it's a typo. */
export const CALLER_PLACEHOLDER_SCRIPTS = ['confirmName', 'reservationSaved'] as const;

/**
 * The opening "how can I help?" sentence, chosen from `languages.settings.<code>.openingQuestions`.
 * Only meaningful in the scripts a call opens with; elsewhere it is a typo.
 */
export const OPENING_PLACEHOLDER = 'openingQuestion';
export const OPENING_PLACEHOLDER_SCRIPTS = [
  'greeting',
  'englishGreeting',
  'returningGreeting',
] as const;

export const ALLOWED_PLACEHOLDERS = [
  ...CLINIC_PLACEHOLDERS,
  ...CALLER_PLACEHOLDERS,
  OPENING_PLACEHOLDER,
] as const;

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
    ...reservationFlowIssues(config),
    ...recallIssues(config),
    ...notificationIssues(config),
    ...transferIssues(config),
  ];
}

/** The service-address question belongs to the `simple` booking flow only (VP-19). */
function reservationFlowIssues(config: ClientConfig): ConfigIssue[] {
  const flow = config.reservationFlow;
  const issues: ConfigIssue[] = [];
  if (flow?.askServiceAddress && flow.mode !== 'simple') {
    issues.push({
      path: 'reservationFlow.askServiceAddress',
      message: 'is only used by the "simple" booking flow — set reservationFlow.mode to "simple"',
    });
  }
  // VP-20: the spoken-address question is the fallback when a postal-code lookup fails.
  if (flow?.postalCodeLookup && (flow.mode !== 'simple' || !flow.askServiceAddress)) {
    issues.push({
      path: 'reservationFlow.postalCodeLookup',
      message:
        'needs the "simple" booking flow and reservationFlow.askServiceAddress (the fallback ' +
        'asked when a lookup fails)',
    });
  }
  return issues;
}

/**
 * VP-26: what a recall line may say. The owner approved a visit's DATE and SERVICE only, so a line
 * may use `[[date]]` and, when it has a service, `[[service]]` — nothing else the model could fill
 * in (a time, a name). A no-service line using `[[service]]` would have the model speak the
 * placeholder, or invent a service; a line missing `[[date]]` would say nothing useful.
 */
const RECALL_PLACEHOLDERS = ['date', 'service'] as const;

function recallIssues(config: ClientConfig): ConfigIssue[] {
  const scripts = config.reservationFlow?.recall?.scripts;
  if (!scripts) return [];

  const rules = [
    { key: 'visitAcknowledgement', needs: ['date', 'service'], forbids: [] as string[] },
    { key: 'visitAcknowledgementNoService', needs: ['date'], forbids: ['service'] },
  ] as const;

  return rules.flatMap(({ key, needs, forbids }) =>
    Object.entries(scripts[key]).flatMap(([code, text]) => {
      const path = `reservationFlow.recall.scripts.${key}.${code}`;
      const used = new Set(
        [...text.matchAll(PLACEHOLDER_PATTERN)].map((match) => (match[1] ?? '').trim()),
      );
      const known = [...RECALL_PLACEHOLDERS, ...CLINIC_PLACEHOLDERS] as readonly string[];
      return [
        ...[...used]
          .filter((name) => !known.includes(name))
          .map((name) => ({
            path,
            message:
              `"[[${name}]]" is not allowed here — a recall line may only say the visit's ` +
              '[[date]] and [[service]] (never its time, a name or any detail)',
          })),
        ...needs
          .filter((name) => !used.has(name))
          .map((name) => ({ path, message: `must contain "[[${name}]]"` })),
        ...forbids
          .filter((name) => used.has(name))
          .map((name) => ({
            path,
            message: `must not use "[[${name}]]" — this line is said when there is no ${name} to give`,
          })),
      ];
    }),
  );
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
    ...(config.emergency ? [{ path: 'emergency.script', text: config.emergency.script }] : []),
    ...transferBlocks(config),
    ...(config.reservationFlow?.askServiceAddress
      ? [
          {
            path: 'reservationFlow.askServiceAddress',
            text: config.reservationFlow.askServiceAddress,
          },
        ]
      : []),
    ...Object.entries(config.reservationFlow?.postalCodeLookup ?? {}).map(([key, text]) => ({
      path: `reservationFlow.postalCodeLookup.${key}`,
      text,
    })),
    ...Object.entries(config.reservationFlow?.changes?.scripts ?? {}).map(([key, text]) => ({
      path: `reservationFlow.changes.scripts.${key}`,
      text,
    })),
    ...Object.entries(config.reservationFlow?.recall?.scripts ?? {}).map(([key, text]) => ({
      path: `reservationFlow.recall.scripts.${key}`,
      text,
    })),
    ...config.faq.flatMap((entry, index) => [
      { path: `faq[${index}].question`, text: entry.question },
      { path: `faq[${index}].answer`, text: entry.answer },
    ]),
  ];
}

/** VP-24: the spoken transfer lines — checked like scripts (every language, known placeholders). */
function transferBlocks(config: ClientConfig): LocalizedBlock[] {
  const transfer = config.transfer;
  if (!transfer) return [];
  return [
    ...TRANSFER_SCRIPT_KEYS.map((key) => ({
      path: `transfer.scripts.${key}`,
      text: transfer.scripts[key],
    })),
    ...(transfer.fallbackPlan
      ? [{ path: 'transfer.fallbackPlan.message', text: transfer.fallbackPlan.message }]
      : []),
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
  const openingPaths = OPENING_PLACEHOLDER_SCRIPTS.map((key) => `scripts.${key}`);

  return [...scriptBlocks, ...transferBlocks(config), ...faqBlocks].flatMap(({ path, text }) =>
    Object.entries(text).flatMap(([code, value]) =>
      checkPlaceholders(`${path}.${code}`, value, {
        allowCaller: allowedPaths.includes(path),
        allowOpening: openingPaths.includes(path),
        // The first entry is what a saved assistant speaks, so a script using the placeholder
        // needs at least one — otherwise the literal "[[openingQuestion]]" would be spoken.
        hasOpeningQuestions: (config.languages.settings[code]?.openingQuestions?.length ?? 0) > 0,
      }),
    ),
  );
}

interface PlaceholderContext {
  allowCaller: boolean;
  allowOpening: boolean;
  hasOpeningQuestions: boolean;
}

function checkPlaceholders(
  path: string,
  value: string,
  context: PlaceholderContext,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const { allowCaller } = context;

  for (const match of value.matchAll(PLACEHOLDER_PATTERN)) {
    const name = (match[1] ?? '').trim();
    const isCaller = (CALLER_PLACEHOLDERS as readonly string[]).includes(name);
    const isKnown = (ALLOWED_PLACEHOLDERS as readonly string[]).includes(name);

    if (name === OPENING_PLACEHOLDER) {
      if (!context.allowOpening) {
        const scriptNames = OPENING_PLACEHOLDER_SCRIPTS.map((key) => `scripts.${key}`).join(', ');
        issues.push({ path, message: `"[[${name}]]" is only allowed in ${scriptNames}` });
      } else if (!context.hasOpeningQuestions) {
        issues.push({
          path,
          message: `"[[${name}]]" needs a non-empty languages.settings.<language>.openingQuestions list`,
        });
      }
      continue;
    }

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
