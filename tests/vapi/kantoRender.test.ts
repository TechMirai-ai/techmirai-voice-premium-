/**
 * VP-19: what the Kanto City Gas demo client renders — prompt, tools, reporting, squad — checked
 * against the work order's decisions (emergency is a script, booking is real, change/cancel and
 * billing fall back to a callback, VP-16 silence handling is the shared mechanism).
 */
import { beforeAll, describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import type { ClientConfig } from '../../src/config/schema.js';
import { FileKnowledgeSource, type FaqEntry } from '../../src/knowledge/KnowledgeSource.js';
import type { ReservationService } from '../../src/repositories/reservationServiceRepository.js';
import { renderCallOutcomeOutput } from '../../src/vapi/callReporting.js';
import { buildSystemPrompt } from '../../src/vapi/promptTemplate.js';
import { renderAssistant, type RenderOptions } from '../../src/vapi/render.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

const KANTO_ID = 'kanto-city-gas-demo';

const SERVICES: ReservationService[] = [
  { id: 'kanto-gas-opening', name: { ja: 'ガスの開栓', en: 'Gas opening' }, durationMinutes: 60 },
  { id: 'kanto-gas-closing', name: { ja: 'ガスの閉栓', en: 'Gas closing' }, durationMinutes: 30 },
];

const OPTIONS: RenderOptions = {
  baseUrl: 'https://example.test',
  credentialId: 'cred-1',
  services: SERVICES,
  outcomeOutputId: 'out-1',
};

const FORBIDDEN_CLINIC_FLOW = [
  'FIRST-TIME VISITOR',
  'RETURNING PATIENT',
  'lookup_patient',
  'Medical questions',
  'Clinic information',
];

let config: ClientConfig;
let faq: FaqEntry[];

beforeAll(async () => {
  config = loadClient(KANTO_ID);
  faq = await new FileKnowledgeSource().listFaq(KANTO_ID);
});

describe('Kanto City Gas — prompt', () => {
  test.each(['ja', 'en'])(
    '%s: the emergency script is said word for word and comes first',
    (language) => {
      const prompt = buildSystemPrompt(config, language, faq, SERVICES);
      const script = config.emergency!.script[language]!;

      expect(prompt).toContain(`"${script}"`);
      expect(prompt.indexOf('Safety emergency')).toBeLessThan(prompt.indexOf('How you speak:'));
    },
  );

  test('the emergency path records a flagged callback and never claims anything was dispatched', () => {
    const prompt = buildSystemPrompt(config, 'en', faq, SERVICES);

    expect(prompt).toContain('exactly "SAFETY: caller reported possible gas smell/leak"');
    expect(prompt).toContain('Nothing has been notified, paged or dispatched');
    expect(prompt).toContain('Never say or imply that anyone has been alerted');
  });

  test('the emergency asks the name in the same reply as the script, so there is no silent gap', () => {
    const prompt = buildSystemPrompt(config, 'ja', faq, SERVICES);

    expect(prompt).toContain(`— and in that same reply, ask: "${config.scripts.askName['ja']}"`);
  });

  test('there is exactly one emergency wording: the FAQ answer equals the emergency script', () => {
    const smell = faq.find((entry) => entry.id === 'gas-smell')!;

    for (const language of config.languages.supported) {
      expect(smell.answer[language]).toBe(config.emergency!.script[language]);
    }
  });

  test.each(['ja', 'en'])(
    '%s: uses the simple booking flow, with no clinic-only paths',
    (language) => {
      const prompt = buildSystemPrompt(config, language, faq, SERVICES);

      for (const text of FORBIDDEN_CLINIC_FLOW) expect(prompt).not.toContain(text);
      expect(prompt).toContain('There is no first-time / returning split');
      expect(prompt).toContain('Company information');
      expect(prompt).toContain('id: kanto-gas-opening');
      expect(prompt).toContain('id: kanto-gas-closing');
    },
  );

  test('collects the address from a postal-code lookup, keeping the spoken address as the fallback (VP-20)', () => {
    const prompt = buildSystemPrompt(config, 'en', faq, SERVICES);
    const flow = config.reservationFlow!;

    expect(prompt).toContain(flow.postalCodeLookup!.askPostalCode['en']);
    expect(prompt).toContain('call lookup_postal_code');
    expect(prompt).toContain(flow.postalCodeLookup!.askBuildingAndRoom['en']);
    expect(prompt).toContain(flow.postalCodeLookup!.lookupFailed['en']);
    expect(prompt).toContain(flow.askServiceAddress!['en']);
    expect(prompt).toContain('The address is not an argument of any tool');
  });

  test('without postalCodeLookup the plain spoken-address step is unchanged', () => {
    const { postalCodeLookup: _removed, ...flow } = config.reservationFlow!;
    const prompt = buildSystemPrompt({ ...config, reservationFlow: flow }, 'en', faq, SERVICES);

    expect(prompt).toContain(config.reservationFlow!.askServiceAddress!['en']);
    expect(prompt).toContain('It is not an argument of any tool');
    expect(prompt).not.toContain('lookup_postal_code');
  });

  test('states what the assistant cannot do, so it falls back to a callback instead of claiming success', () => {
    const prompt = buildSystemPrompt(config, 'en', faq, SERVICES);

    expect(prompt).toContain(
      'change or cancel an existing appointment, send SMS messages or links',
    );
    expect(prompt).toContain(
      'offer a staff callback instead and never say or imply that you did it',
    );
  });

  test('keeps the shared conversational-quality rules (VP-17) exactly as for any client', () => {
    const prompt = buildSystemPrompt(config, 'en', faq, SERVICES);
    const sakuraPrompt = buildSystemPrompt(loadClient(SAKURA_ID), 'en', faq, []);

    for (const rule of [
      'Natural acknowledgements:',
      'No filler before important information:',
      'Interrupted: stop',
    ]) {
      expect(prompt).toContain(rule);
      expect(sakuraPrompt).toContain(rule);
    }
  });
});

describe('Kanto City Gas — rendered assistants', () => {
  test.each(['ja', 'en', 'ja-return'])('%s: renders under a client-prefixed name', (memberId) => {
    const { assistant } = renderAssistant(config, memberId, faq, OPTIONS);

    expect(assistant.name).toBe(`${KANTO_ID}--${memberId}`);
  });

  test('booking tools are availability, postal-code lookup and booking; no patient lookup, no returning-patient argument', () => {
    const { reservationTools } = renderAssistant(config, 'ja', faq, OPTIONS);
    const book = reservationTools.find((tool) => tool.key === 'book-appointment')!.payload;
    const parameters = book.function.parameters as {
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };

    expect(reservationTools.map((tool) => tool.key)).toEqual([
      'check-availability',
      'lookup-postal-code',
      'book-appointment',
    ]);
    expect(Object.keys(parameters.properties)).not.toContain('isReturningPatient');
    // The address is never a booking argument (F-11): it reaches staff through the call summary.
    expect(Object.keys(parameters.properties).join(',')).not.toMatch(/address|postal|building/i);
    expect(parameters.properties['serviceId']?.enum).toEqual([
      'kanto-gas-opening',
      'kanto-gas-closing',
    ]);
    expect(parameters.required).toContain('serviceId');
  });

  test('the call-outcome summary must start with the safety flag and must carry the service address', () => {
    const description = JSON.stringify(renderCallOutcomeOutput(config, faq));

    expect(description).toContain(
      'MUST begin with exactly \\"SAFETY: caller reported possible gas smell/leak\\"',
    );
    expect(description).toContain(
      'include the complete address — postal code, prefecture, city, town, then building and room',
    );
    expect(description).toContain('customer-service staff');
  });

  test("VP-16 silence handling is the shared mechanism: same hook shape as sakura, this client's wording", () => {
    const kanto = renderAssistant(config, 'ja', faq, OPTIONS).assistant;
    const sakura = renderAssistant(loadClient(SAKURA_ID), 'ja', faq, OPTIONS).assistant;

    expect(kanto.hooks.map((hook) => hook.on)).toEqual(sakura.hooks.map((hook) => hook.on));
    expect(kanto.hooks.length).toBeGreaterThan(0);
    expect(JSON.stringify(kanto.hooks)).toContain(config.scripts.silenceCheck1['ja']);
  });

  test.each(['ja', 'en', 'ja-return'])(
    '%s: hands off to exactly the same targets as the same member of the sakura squad',
    (memberId) => {
      const kanto = renderAssistant(config, memberId, faq, OPTIONS);
      const sakura = renderAssistant(loadClient(SAKURA_ID), memberId, faq, OPTIONS);

      expect(kanto.handoffTools.length).toBeGreaterThan(0);
      expect(kanto.handoffTools.map((tool) => tool.toLanguage)).toEqual(
        sakura.handoffTools.map((tool) => tool.toLanguage),
      );
    },
  );

  test('nothing from the clinic client leaks into a rendered Kanto assistant', () => {
    const rendered = JSON.stringify([
      renderAssistant(config, 'ja', faq, OPTIONS),
      renderAssistant(config, 'en', faq, OPTIONS),
    ]).toLowerCase();

    for (const leaked of ['seikotsuin', '整骨院', 'general-consultation', 'sports-injury']) {
      expect(rendered).not.toContain(leaked);
    }
  });
});
