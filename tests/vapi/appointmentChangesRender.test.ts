/**
 * VP-25: what a client that opts in (`reservationFlow.changes`) renders — three function tools and a
 * prompt section — and that a client that does not opt in renders none of it.
 */
import { beforeAll, describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { parseClientConfig, type ClientConfig } from '../../src/config/schema.js';
import { FileKnowledgeSource, type FaqEntry } from '../../src/knowledge/KnowledgeSource.js';
import type { ReservationService } from '../../src/repositories/reservationServiceRepository.js';
import { buildSystemPrompt } from '../../src/vapi/promptTemplate.js';
import { renderAssistant, type RenderOptions } from '../../src/vapi/render.js';
import { readSakuraDocument, SAKURA_ID, withChanges } from '../helpers/clientFixtures.js';

const SERVICES: ReservationService[] = [
  {
    id: 'general-consultation',
    name: { ja: '一般施術', en: 'General Consultation' },
    durationMinutes: 30,
  },
  {
    id: 'sports-injury',
    name: { ja: 'スポーツ外傷施術', en: 'Sports Injury Treatment' },
    durationMinutes: 45,
  },
];

const OPTIONS: RenderOptions = {
  baseUrl: 'https://example.test',
  credentialId: 'cred-1',
  services: SERVICES,
  outcomeOutputId: 'out-1',
};

const CHANGE_TOOLS = ['find_my_appointments', 'cancel_appointment', 'reschedule_appointment'];

let sakura: ClientConfig;
let sakuraFaq: FaqEntry[];

beforeAll(async () => {
  sakura = loadClient(SAKURA_ID);
  sakuraFaq = await new FileKnowledgeSource().listFaq(SAKURA_ID);
});

const toolsOf = (config: ClientConfig, faq: FaqEntry[], language = 'ja') =>
  renderAssistant(config, language, faq, OPTIONS).reservationTools;

describe('rendered tools', () => {
  test('an opted-in client gets the three change tools beside the booking tools', () => {
    // VP-26's recall tool is covered by recallRender.test.ts; this test is about VP-25's three.
    const tools = toolsOf(sakura, sakuraFaq).filter((tool) => tool.key !== 'recall-last-visit');

    expect(tools.map((tool) => tool.key)).toEqual([
      'check-availability',
      'lookup-patient',
      'book-appointment',
      'find-appointments',
      'cancel-appointment',
      'reschedule-appointment',
    ]);
    expect(tools.map((tool) => tool.payload.function.name)).toEqual(
      expect.arrayContaining(CHANGE_TOOLS),
    );
  });

  test('each change tool posts to its own authenticated endpoint', () => {
    const byKey = Object.fromEntries(
      toolsOf(sakura, sakuraFaq).map((tool) => [tool.key, tool.payload]),
    );

    expect(byKey['find-appointments']?.server).toEqual({
      url: 'https://example.test/api/voice/find-my-appointments',
      credentialId: 'cred-1',
    });
    expect(byKey['cancel-appointment']?.server.url).toBe(
      'https://example.test/api/voice/cancel-appointment',
    );
    expect(byKey['reschedule-appointment']?.server.url).toBe(
      'https://example.test/api/voice/reschedule-appointment',
    );
  });

  test('the tools take an appointment id and a new slot — never a phone number or a name', () => {
    const byName = Object.fromEntries(
      toolsOf(sakura, sakuraFaq).map((tool) => [tool.payload.function.name, tool.payload.function]),
    );

    expect(byName['find_my_appointments']?.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
    expect(byName['cancel_appointment']?.parameters.required).toEqual(['appointmentId']);
    expect(byName['reschedule_appointment']?.parameters.required).toEqual([
      'appointmentId',
      'date',
      'time',
    ]);
    for (const name of CHANGE_TOOLS) {
      const properties = Object.keys(byName[name]?.parameters.properties ?? {});
      expect(properties.join(' ')).not.toMatch(/phone|name(?!d)|number/i);
    }
  });

  test('a client that has not opted in gets none of them', async () => {
    const kanto = loadClient('kanto-city-gas-demo');
    const faq = await new FileKnowledgeSource().listFaq('kanto-city-gas-demo');

    const names = toolsOf(kanto, faq).map((tool) => tool.payload.function.name);

    for (const name of CHANGE_TOOLS) expect(names).not.toContain(name);
  });

  test('a client with no bookable services has no change tools either (nothing to change)', () => {
    const options = { ...OPTIONS, services: [] };

    const rendered = renderAssistant(sakura, 'ja', sakuraFaq, options);

    expect(rendered.reservationTools).toEqual([]);
  });
});

describe('prompt section', () => {
  test.each(['ja', 'en'])('%s: names the tools and speaks the client’s own lines', (language) => {
    const prompt = buildSystemPrompt(sakura, language, sakuraFaq, SERVICES);
    const scripts = sakura.reservationFlow!.changes!.scripts;

    for (const name of CHANGE_TOOLS) expect(prompt).toContain(name);
    for (const key of ['found', 'askWhich', 'confirmCancel', 'cancelled', 'rescheduled'] as const) {
      expect(prompt).toContain(scripts[key][language]!);
    }
    expect(prompt).toContain(scripts.notFound[language]!);
    expect(prompt).toContain(scripts.failed[language]!);
  });

  test('looks the booking up first and reads it back for a clear yes before doing anything', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/Call find_my_appointments.*before/s);
    expect(prompt).toMatch(/explicit yes.*cancel_appointment/s);
    expect(prompt).toMatch(/never say an id aloud|never read an id/i);
    expect(prompt).toMatch(/several|more than one/i);
  });

  test('a reschedule goes through check_availability and updates, never books a duplicate', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/reschedule_appointment/);
    expect(prompt).toMatch(/never (name|suggest)[^.]*check_availability/i);
    expect(prompt).toMatch(/never call book_appointment[^.]*reschedul/i);
  });

  test('no match falls back to the callback flow instead of ending on "not found"', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/request_callback/);
    expect(prompt).toMatch(/none were found|no upcoming appointment/i);
    expect(prompt).toMatch(/callback/i);
  });

  test('says only one change can be made per call, and never to look up by a spoken number', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/one change per call/i);
    expect(prompt).toMatch(/never ask for[^.]*phone number/i);
  });

  test('also renders in the simple booking flow', () => {
    const simple = parseClientConfig(
      withChanges(readSakuraDocument(), (draft) => {
        draft.reservationFlow.mode = 'simple';
      }),
      SAKURA_ID,
    ).config;

    const prompt = buildSystemPrompt(simple, 'en', sakuraFaq, SERVICES);

    expect(prompt).toContain('find_my_appointments');
  });

  test('a client that has not opted in says nothing of it', async () => {
    const kanto = loadClient('kanto-city-gas-demo');
    const faq = await new FileKnowledgeSource().listFaq('kanto-city-gas-demo');

    const prompt = buildSystemPrompt(kanto, 'en', faq, SERVICES);

    for (const name of CHANGE_TOOLS) expect(prompt).not.toContain(name);
  });
});

describe('config validation', () => {
  test('rejects a client that allows changes but has no way to alert staff to them', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          delete draft.notifications.line.changeTemplates;
        }),
        SAKURA_ID,
      ),
    ).toThrow(/notifications\.line\.changeTemplates/);
  });

  test('rejects changes for a client with no notifications at all (staff would never hear)', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          delete draft.notifications;
        }),
        SAKURA_ID,
      ),
    ).toThrow(/notifications\.line\.changeTemplates/);
  });

  test('rejects changes for a client whose notifications have SMS but no LINE alert', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          delete draft.notifications.line;
        }),
        SAKURA_ID,
      ),
    ).toThrow(/notifications\.line\.changeTemplates/);
  });

  test('rejects change lines missing for a supported language', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          delete draft.reservationFlow.changes.scripts.cancelled.en;
        }),
        SAKURA_ID,
      ),
    ).toThrow(/reservationFlow\.changes\.scripts\.cancelled\.en/);
  });

  test('rejects an unknown placeholder or a link in a change SMS', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          draft.notifications.sms.changeTemplates.cancelled.en =
            'Cancelled [[patientName]] see https://example.com';
        }),
        SAKURA_ID,
      ),
    ).toThrow(/patientName|URL/);
  });

  test('the staff alert may use where the booking was before', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          draft.notifications.line.changeTemplates.rescheduled =
            '[[oldDate]] [[oldTime]] -> [[date]] [[time]]';
        }),
        SAKURA_ID,
      ),
    ).not.toThrow();
  });

  test('a client without the section is unaffected', () => {
    expect(() =>
      parseClientConfig(
        withChanges(readSakuraDocument(), (draft) => {
          delete draft.reservationFlow;
          delete draft.notifications.line.changeTemplates;
          delete draft.notifications.sms.changeTemplates;
        }),
        SAKURA_ID,
      ),
    ).not.toThrow();
  });
});
