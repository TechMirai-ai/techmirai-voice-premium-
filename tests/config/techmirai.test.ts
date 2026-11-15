/** TechMirai's own client: its config, the consultation rules, its prompt and its archive isolation. */
import { describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { readFileSync } from 'node:fs';

import { loadClient } from '../../src/config/loadClient.js';
import { parseClientConfig } from '../../src/config/schema.js';
import { resolveArchiveDestination } from '../../src/google/archiveDestination.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { buildSystemPrompt } from '../../src/vapi/promptTemplate.js';
import { renderAssistant } from '../../src/vapi/render.js';
import { captureIssues, REAL_CLIENTS_DIR } from '../helpers/clientFixtures.js';
import path from 'node:path';

const ID = 'techmirai-ai';

function expectConfigError(fn: () => unknown, pattern: RegExp): void {
  const { issues } = captureIssues(fn);
  expect(issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n')).toMatch(pattern);
}
const document = (): Record<string, any> =>
  parseYaml(readFileSync(path.join(REAL_CLIENTS_DIR, ID, 'client.yaml'), 'utf8')) as Record<
    string,
    any
  >;
const mutated = (change: (draft: Record<string, any>) => void) => {
  const draft = structuredClone(document());
  change(draft);
  return () => parseClientConfig(draft, ID);
};

describe('clients/techmirai-ai/client.yaml', () => {
  const config = loadClient(ID);

  test('loads, is its own client, and has transfer switched off', () => {
    expect(config.clientId).toBe(ID);
    expect(config.transfer).toBeUndefined();
    expect(config.consultation?.contactEmail).toBe('info@techmirai-ai.com');
  });

  test('staff contact hours are Monday to Friday 09:00-18:00 Japan time, with no holiday claim', () => {
    const { hours } = config.business;
    expect(hours.timezone).toBe('Asia/Tokyo');
    for (const day of ['mon', 'tue', 'wed', 'thu', 'fri'] as const) {
      expect(hours.weekly[day]).toEqual({ open: '09:00', close: '18:00' });
    }
    expect(hours.weekly.sat).toBe('closed');
    expect(hours.weekly.sun).toBe('closed');
    expect(hours.closedOnNationalHolidays).toBeUndefined();
    expect(config.consultation?.contactHours.en).toBe(
      'on weekdays between 9 a.m. and 6 p.m. Japan time',
    );
  });

  test('SMS: alphanumeric sender "TechMirai", Japanese mobiles only, 24 h cooldown, 20 a day', () => {
    const sms = config.notifications?.sms;
    expect(sms?.senderId).toBe('TechMirai');
    expect(sms?.allowedCountryCodes).toEqual(['+81']);
    expect(sms?.allowedNumberPrefixes).toEqual(['+8170', '+8180', '+8190']);
    expect(sms?.consultationCooldownHours).toBe(24);
    expect(sms?.maxPerDay).toBe(20);
  });

  test('LINE recipients are TechMirai’s own env var names (a list, so a group id can be added)', () => {
    expect(config.notifications?.line?.recipientEnvs).toEqual(['LINE_TECHMIRAI_STAFF_USER_ID']);
  });

  test('its FAQ is the FAQ v2 file, entry for entry', () => {
    const markdown = readFileSync(
      path.join(REAL_CLIENTS_DIR, '..', 'techmirai-ai-FAQ-v2.md'),
      'utf8',
    );
    const entries = [...markdown.matchAll(/^### (\w+) /gm)].map((m) => m[1]!.toLowerCase());
    expect(config.faq.map((entry) => entry.id)).toEqual(entries);
    for (const entry of config.faq) {
      const id = entry.id.toUpperCase();
      const block = markdown.split(new RegExp(`^### ${id} `, 'm'))[1]!.split(/^### /m)[0]!;
      for (const language of ['en', 'ja'] as const) {
        expect(block).toContain(`- ${language.toUpperCase()} answer: ${entry.answer[language]}`);
        expect(block).toContain(
          `- ${language.toUpperCase()} question: ${entry.question[language]}`,
        );
      }
    }
  });

  test('L2 and L3 say weekdays', () => {
    const answer = (id: string) => config.faq.find((e) => e.id === id)?.answer.en ?? '';
    expect(answer('l2')).toContain('weekdays between 9 a.m. and 6 p.m. Japan time');
    expect(answer('l3')).toContain('weekdays between 9 a.m. and 6 p.m. Japan time');
  });
});

describe('consultation rules', () => {
  test('a script missing a language is a config error', () => {
    expectConfigError(
      mutated((d) => delete d.consultation.scripts.saved.en),
      /consultation\.scripts\.saved\.en/,
    );
  });

  test('an unknown placeholder in a consultation script is a config error', () => {
    expectConfigError(
      mutated((d) => (d.consultation.scripts.saved.en = 'Hi [[patientName]]')),
      /unknown placeholder "\[\[patientName\]\]"/,
    );
  });

  test('a consultation client must not have transfer switched on', () => {
    expectConfigError(
      mutated((d) => {
        d.transfer = { ...loadClient('sakura-seikotsuin').transfer };
      }),
      /transfer\.enabled/,
    );
  });

  test('SMS notifications need consultation templates; LINE needs the staff alert', () => {
    expectConfigError(
      mutated((d) => delete d.notifications.sms.consultationTemplates),
      /notifications\.sms\.consultationTemplates/,
    );
    expectConfigError(
      mutated((d) => delete d.notifications.line.consultationTemplate),
      /notifications\.line\.consultationTemplate/,
    );
  });

  test('a link in the consultation SMS template is refused; the e-mail comes from a placeholder', () => {
    expectConfigError(
      mutated(
        (d) => (d.notifications.sms.consultationTemplates.en = 'See https://techmirai-ai.com'),
      ),
      /must not contain a URL/,
    );
  });

  test('an unknown LINE placeholder is refused', () => {
    expectConfigError(
      mutated((d) => (d.notifications.line.consultationTemplate += '\n[[secret]]')),
      /unknown placeholder "\[\[secret\]\]"/,
    );
  });

  test('allowedNumberPrefixes must look like "+8190"', () => {
    expectConfigError(
      mutated((d) => (d.notifications.sms.allowedNumberPrefixes = ['090'])),
      /allowedNumberPrefixes/,
    );
  });
});

describe('prompt and tools', () => {
  const config = loadClient(ID);
  const faq = () => new FileKnowledgeSource().listFaq(ID);

  test.each(['ja', 'en'])(
    'the %s prompt runs the consultation flow, not callbacks or transfer',
    async (language) => {
      const prompt = buildSystemPrompt(config, language, await faq());

      expect(prompt).toContain('Consultation requests');
      expect(prompt).toContain('request_consultation');
      expect(prompt).not.toContain('request_callback');
      expect(prompt).not.toContain('Staff transfer');
      expect(prompt).toContain('cannot transfer calls');
      expect(prompt).toContain('phone_source "caller_id"');
      expect(prompt).toContain('phone_source "spoken"');
      expect(prompt).not.toMatch(/\bclinic\b|\bpatient/i);
    },
  );

  test('the hours line states no holiday claim to the model', async () => {
    const prompt = buildSystemPrompt(config, 'en', await faq());

    expect(prompt).not.toContain('Closed on national holidays');
  });

  test('each squad member gets request_consultation as its primary tool, and no transfer tool', async () => {
    for (const member of ['ja', 'ja-return', 'en']) {
      const rendered = renderAssistant(config, member, await faq(), {
        baseUrl: 'https://example.invalid',
        credentialId: 'cred',
        services: [],
      });

      expect(rendered.tool.function.name).toBe('request_consultation');
      expect(rendered.tool.server?.url).toBe(
        'https://example.invalid/api/voice/request-consultation',
      );
      expect(Object.keys(rendered.tool.function.parameters.properties)).toEqual([
        'contact_name',
        'phone_source',
        'spoken_phone',
        'reason',
        'language',
      ]);
      expect(rendered.transferTool).toBeUndefined();
    }
  });

  test('the greeting keeps the recording notice', () => {
    expect(config.scripts.greeting.ja).toContain('この通話は録音されます');
    expect(config.scripts.englishGreeting.en).toContain('This call is recorded');
    expect(config.scripts.returningGreeting.en).toContain('This call is recorded');
  });
});

describe('archive isolation', () => {
  const DEMO_ENV = {
    GOOGLE_ARCHIVE_SHEET_ID: 'demo-sheet',
    GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: 'demo-audio',
    GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID: 'demo-transcripts',
  };

  test('it does not opt in to the shared demo archive', () => {
    expect(loadClient(ID).archive.sharedDemoArchive).toBeUndefined();
  });

  test('with its own variables unset it fails closed — even though the demo archive is set', () => {
    const result = resolveArchiveDestination(ID, loadClient, DEMO_ENV);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('GOOGLE_ARCHIVE_TECHMIRAI_SHEET_ID');
    expect(result.message).not.toContain('demo-sheet');
  });

  test('with its own variables set it resolves to them, never the demo archive', () => {
    const result = resolveArchiveDestination(ID, loadClient, {
      ...DEMO_ENV,
      GOOGLE_ARCHIVE_TECHMIRAI_SHEET_ID: 'tm-sheet',
      GOOGLE_ARCHIVE_TECHMIRAI_DRIVE_FOLDER_ID: 'tm-audio',
      GOOGLE_ARCHIVE_TECHMIRAI_TRANSCRIPT_FOLDER_ID: 'tm-transcripts',
    });

    expect(result).toEqual({
      ok: true,
      destination: {
        sheetId: 'tm-sheet',
        audioFolderId: 'tm-audio',
        transcriptFolderId: 'tm-transcripts',
      },
    });
  });
});
