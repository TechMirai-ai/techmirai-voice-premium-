/**
 * VP-26: what a client that opts in (`reservationFlow.recall`) renders — one silent function tool
 * and a prompt section — and that a client that does not opt in renders none of it.
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
];

const OPTIONS: RenderOptions = {
  baseUrl: 'https://example.test',
  credentialId: 'cred-1',
  services: SERVICES,
  outcomeOutputId: 'out-1',
};

const TOOL = 'recall_last_visit';

let sakura: ClientConfig;
let sakuraWithoutRecall: ClientConfig;
let sakuraFaq: FaqEntry[];

beforeAll(async () => {
  sakura = loadClient(SAKURA_ID);
  sakuraWithoutRecall = parseClientConfig(
    withChanges(readSakuraDocument(), (draft) => {
      delete draft.reservationFlow.recall;
    }),
    SAKURA_ID,
  ).config;
  sakuraFaq = await new FileKnowledgeSource().listFaq(SAKURA_ID);
});

const toolsOf = (config: ClientConfig, faq: FaqEntry[], options = OPTIONS) =>
  renderAssistant(config, 'ja', faq, options).reservationTools;

describe('rendered tool', () => {
  test('an opted-in client gets the recall tool beside the booking tools', () => {
    const tool = toolsOf(sakura, sakuraFaq).find((entry) => entry.key === 'recall-last-visit');

    expect(tool?.payload.function.name).toBe(TOOL);
    expect(tool?.payload.server).toEqual({
      url: 'https://example.test/api/voice/recall-last-visit',
      credentialId: 'cred-1',
    });
  });

  test('it takes no arguments — the number comes from the call, never from the model', () => {
    const tool = toolsOf(sakura, sakuraFaq).find((entry) => entry.key === 'recall-last-visit');

    expect(tool?.payload.function.parameters).toEqual({
      type: 'object',
      properties: {},
      required: [],
    });
  });

  test('it is silent: a background lookup must not make the assistant say "please wait"', () => {
    const tool = toolsOf(sakura, sakuraFaq).find((entry) => entry.key === 'recall-last-visit');

    expect(tool?.payload.messages ?? []).toEqual([]);
  });

  test('a client that has not opted in gets no recall tool', async () => {
    const kanto = loadClient('kanto-city-gas-demo');
    const faq = await new FileKnowledgeSource().listFaq('kanto-city-gas-demo');

    const withoutRecall = toolsOf(sakuraWithoutRecall, sakuraFaq).map(
      (entry) => entry.payload.function.name,
    );
    expect(withoutRecall).not.toContain(TOOL);
    expect(toolsOf(kanto, faq).map((entry) => entry.payload.function.name)).not.toContain(TOOL);
  });

  test('a client with no bookable services has no recall tool either (no bookings to recall)', () => {
    expect(toolsOf(sakura, sakuraFaq, { ...OPTIONS, services: [] })).toEqual([]);
  });
});

describe('prompt section', () => {
  test.each(['ja', 'en'])('%s: names the tool and speaks the client’s own lines', (language) => {
    const prompt = buildSystemPrompt(sakura, language, sakuraFaq, SERVICES);
    const scripts = sakura.reservationFlow!.recall!.scripts;

    expect(prompt).toContain(TOOL);
    expect(prompt).toContain(scripts.visitAcknowledgement[language]!);
    expect(prompt).toContain(scripts.visitAcknowledgementNoService[language]!);
  });

  test('limits what is said to the date and service, and says nothing without a record', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/only the date and the service/i);
    expect(prompt).toMatch(/never (say|mention)[^.]*time/i);
    expect(prompt).toMatch(/no earlier visit[^.]*say nothing about/is);
    expect(prompt).toMatch(/never (claim|imply|guess)/i);
  });

  test('presents it as a booking in the records, never as a visit or attendance', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toContain('Our records show a booking on [[date]] for [[service]].');
    expect(prompt).toMatch(/never call it a visit/i);
    expect(prompt).toMatch(/never say the caller visited or attended/i);
  });

  test('a caller who asks for more is told staff can help — nothing further is said', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/asks (for )?(more|details)[^.]*callback/is);
  });

  test('at most one earlier-contact line per call: the visit acknowledgement wins over the VP-15 line', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(/at most one line about an earlier/i);
    expect(prompt).toMatch(/visit acknowledgement[^.]*(takes priority|wins)/i);
  });

  test('never says "welcome back" twice when the caller was already welcomed back (VP-15 greeting)', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, SERVICES);

    expect(prompt).toMatch(
      /already (welcomed|greeted)[^.]*(do not|don't|never)[^.]*(repeat|welcome)/i,
    );
  });

  test('a client with recall configured but no bookable services names the tool nowhere (it is not rendered)', () => {
    const prompt = buildSystemPrompt(sakura, 'en', sakuraFaq, []);

    expect(prompt).not.toContain(TOOL);
    expect(prompt).toContain('Earlier call from this caller');
  });

  test('a client that has not opted in has none of this wording — and VP-15’s section is untouched', () => {
    const prompt = buildSystemPrompt(sakuraWithoutRecall, 'en', sakuraFaq, SERVICES);

    expect(prompt).not.toContain(TOOL);
    expect(prompt).not.toMatch(/at most one line about an earlier/i);
    expect(prompt).toContain('Earlier call from this caller');
  });
});
