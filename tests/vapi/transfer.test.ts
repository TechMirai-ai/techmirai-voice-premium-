/**
 * VP-24: what a client's `transfer` block renders — the `transfer_to_staff` function tool, and the
 * "Staff transfer" rules in the system prompt (hours-gated, callback-first for out-of-scope requests).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, test } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { loadClient } from '../../src/config/loadClient.js';
import { parseClientConfig, type ClientConfig } from '../../src/config/schema.js';
import { FileKnowledgeSource, type FaqEntry } from '../../src/knowledge/KnowledgeSource.js';
import { buildSystemPrompt } from '../../src/vapi/promptTemplate.js';
import { renderAssistant, type RenderOptions } from '../../src/vapi/render.js';
import { renderTransferTool, transferToolStateName } from '../../src/vapi/transferTool.js';
import {
  readSakuraDocument,
  REAL_CLIENTS_DIR,
  SAKURA_ID,
  withChanges,
} from '../helpers/clientFixtures.js';

const KANTO_ID = 'kanto-city-gas-demo';
const OPTIONS: RenderOptions = { baseUrl: 'https://example.test', credentialId: 'cred-1' };
const sakuraDocument = readSakuraDocument();

const sakuraWith = (mutate: (draft: Record<string, any>) => void): ClientConfig =>
  parseClientConfig(withChanges(sakuraDocument, mutate), SAKURA_ID).config;

let sakura: ClientConfig;
let sakuraFaq: FaqEntry[];

beforeAll(async () => {
  sakura = loadClient(SAKURA_ID);
  sakuraFaq = await new FileKnowledgeSource().listFaq(SAKURA_ID);
});

describe('renderTransferTool', () => {
  const render = (config: ClientConfig) =>
    renderTransferTool(config, 'https://example.test', 'cred-1');

  test('is a function tool whose webhook is our own transfer endpoint, behind the shared credential', () => {
    const tool = render(sakura);

    expect(tool?.type).toBe('function');
    expect(tool?.function.name).toBe('transfer_to_staff');
    expect(tool?.function.parameters).toEqual({ type: 'object', properties: {}, required: [] });
    expect(tool?.server).toEqual({
      url: 'https://example.test/api/voice/transfer-to-staff',
      credentialId: 'cred-1',
    });
  });

  test("is NOT Vapi's native transferCall tool: nothing here can move a call by itself", () => {
    const text = JSON.stringify(render(sakura));

    expect(text).not.toContain('transferCall');
    expect(text).not.toContain('destinations');
  });

  test('carries no phone number at all: the staff number never reaches Vapi', () => {
    const text = JSON.stringify(render(sakura));

    expect(text).not.toMatch(/\+\d{6,}/);
    expect(text).not.toContain(sakura.transfer?.numberEnv);
  });

  test('is silent on its own: the announcement is sent by the server with the transfer', () => {
    expect(render(sakura)?.messages).toEqual([
      { type: 'request-start', content: '' },
      { type: 'request-complete', content: '' },
      { type: 'request-failed', content: '' },
    ]);
  });

  test('renders nothing when the block is switched off or absent', () => {
    const off = sakuraWith((draft) => {
      draft['transfer'].enabled = false;
    });
    const absent = sakuraWith((draft) => {
      delete draft['transfer'];
    });

    expect(render(off)).toBeUndefined();
    expect(render(absent)).toBeUndefined();
  });

  test('its state-file key is per client and leg, like the other tools', () => {
    expect(transferToolStateName(SAKURA_ID, 'ja')).toBe('sakura-seikotsuin--ja--transfer-call');
    expect(transferToolStateName(SAKURA_ID, 'ja-return')).toBe(
      'sakura-seikotsuin--ja-return--transfer-call',
    );
  });

  test.each(['ja', 'en', 'ja-return'])('renderAssistant exposes it for the %s member', (member) => {
    const tool = renderAssistant(sakura, member, sakuraFaq, OPTIONS).transferTool;

    expect(tool?.function.name).toBe('transfer_to_staff');
    expect(tool?.server.url).toBe('https://example.test/api/voice/transfer-to-staff');
  });
});

describe('the "Staff transfer" prompt section', () => {
  const promptFor = (language: string, config: ClientConfig = sakura) =>
    buildSystemPrompt(config, language, sakuraFaq);

  test('states the hours it is gated on, reusing business.hours (never a second definition)', () => {
    const prompt = promptFor('en');

    expect(prompt).toContain('Staff transfer');
    expect(prompt).toContain('Mon 09:00-19:00');
    expect(prompt).toContain('Sun closed');
    expect(prompt).toContain('Asia/Tokyo');
    expect(prompt).toContain('closed on national holidays');
    expect(prompt).toContain('at least 10 minutes before closing');

    const edited = sakuraWith((draft) => {
      draft['business'].hours.weekly.mon = { open: '10:00', close: '17:30' };
      draft['transfer'].closingBufferMinutes = 25;
    });
    expect(promptFor('en', edited)).toContain('Mon 10:00-17:30');
    expect(promptFor('en', edited)).toContain('at least 25 minutes before closing');
  });

  test('the hours rule points at "Today", which comes after it in the prompt', () => {
    const prompt = promptFor('en');

    expect(prompt.indexOf('Staff transfer')).toBeGreaterThan(-1);
    expect(prompt.indexOf('Today:')).toBeGreaterThan(prompt.indexOf('Staff transfer'));
    expect(prompt).toContain('Use Today (below) to decide');
  });

  test('an explicit request for a person transfers at once, with no confirmation', () => {
    const prompt = promptFor('en');

    expect(prompt).toContain('call transfer_to_staff immediately');
    expect(prompt).toContain('Do not ask for confirmation and do not collect a name first');
  });

  test('outside clinic hours it goes to the callback flow and never offers a transfer', () => {
    const prompt = promptFor('en');

    expect(prompt).toContain(sakura.transfer?.scripts.closedOffer['en']);
    expect(prompt).toContain('Never offer a transfer');
    expect(prompt).toContain('never mention a transfer: take the callback only');
  });

  test('an out-of-scope request takes the callback FIRST, then offers, and transfers only on yes', () => {
    const prompt = promptFor('en');

    expect(prompt).toContain('Do NOT offer a transfer before request_callback has succeeded');
    expect(prompt).toContain(sakura.transfer?.scripts.offer['en']);
    expect(prompt).toContain('An explicit yes: call transfer_to_staff right away');
    expect(prompt).toContain('A clear no: accept it');
    expect(prompt).toContain('ambiguous');
  });

  test('a failed or refused transfer tool leads to the failure line and the callback, never a retry', () => {
    const prompt = promptFor('en');

    expect(prompt).toContain(sakura.transfer?.scripts.failed['en']);
    expect(prompt).toContain('never retry the tool');
  });

  test('the model is told to add no words of its own: the system announces the transfer', () => {
    const prompt = promptFor('en');

    expect(prompt).toContain('add no words of your own before it');
    expect(prompt).toContain(sakura.transfer?.scripts.transferring['en']);
  });

  test('each language leg quotes its own wording', () => {
    const ja = promptFor('ja');

    expect(ja).toContain(sakura.transfer?.scripts.offer['ja']);
    expect(ja).toContain(sakura.transfer?.scripts.closedOffer['ja']);
    expect(ja).not.toContain(sakura.transfer?.scripts.offer['en']);
  });

  test('no staff number — and not even its variable name — appears in the prompt', () => {
    for (const language of ['ja', 'en']) {
      const prompt = promptFor(language);

      expect(prompt).not.toContain(sakura.transfer?.numberEnv);
      expect(prompt).not.toMatch(/\+81\d{8,}/);
    }
  });

  test('the "never claim you can transfer" limits are replaced, not left contradicting the tool', () => {
    const prompt = promptFor('en');

    expect(prompt).not.toContain('make or change bookings, transfer calls');
    expect(prompt).toContain(
      'connect a caller to staff only as the "Staff transfer" section allows',
    );
    expect(prompt).toContain('follow "Staff transfer" below');
  });

  test('a client with no emergency path gets no emergency wording from this section', () => {
    expect(promptFor('en')).not.toMatch(/emergency/i);
  });

  test('switched off, the prompt is exactly what it is with no block at all', () => {
    const off = sakuraWith((draft) => {
      draft['transfer'].enabled = false;
    });
    const absent = sakuraWith((draft) => {
      delete draft['transfer'];
    });

    for (const language of ['ja', 'en']) {
      expect(promptFor(language, off)).toBe(promptFor(language, absent));
    }
    expect(promptFor('en', absent)).not.toContain('Staff transfer');
    expect(promptFor('en', absent)).toContain('make or change bookings, transfer calls');
  });
});

describe('a client with an emergency path', () => {
  const kantoDocument = parseYaml(
    readFileSync(path.join(REAL_CLIENTS_DIR, KANTO_ID, 'client.yaml'), 'utf8'),
  ) as Record<string, any>;

  test('does not get a transfer tool or section until its own block exists', async () => {
    const config = loadClient(KANTO_ID);
    const faq = await new FileKnowledgeSource().listFaq(KANTO_ID);

    expect(renderAssistant(config, 'ja', faq, OPTIONS).transferTool).toBeUndefined();
    expect(buildSystemPrompt(config, 'en', faq)).not.toContain('Staff transfer');
  });

  test('when enabled, the emergency path is stated to override the transfer rules', async () => {
    const config = parseClientConfig(
      withChanges(kantoDocument, (draft) => {
        draft['transfer'] = structuredClone(sakuraDocument['transfer']);
      }),
      KANTO_ID,
    ).config;
    const faq = await new FileKnowledgeSource().listFaq(KANTO_ID);

    expect(buildSystemPrompt(config, 'en', faq)).toContain(
      'The safety emergency path above overrides this section.',
    );
  });
});
