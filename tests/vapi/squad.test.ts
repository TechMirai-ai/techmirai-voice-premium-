import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import {
  MissingArrivalScriptError,
  contentLanguageOf,
  handoffTargets,
  handoffToolStateName,
  orderedLanguages,
  renderArrivalMessage,
  renderHandoffTool,
  renderSquad,
  returnMemberId,
  squadMemberIds,
} from '../../src/vapi/squad.js';
import { UnsupportedLanguageError } from '../../src/vapi/promptTemplate.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';
import { buildMinimalConfig } from '../helpers/vapiFixtures.js';

const config = loadClient(SAKURA_ID);

describe('renderHandoffTool — Sakura', () => {
  test('ja → en targets the English assistant by name, with the English switchKeywords', () => {
    const tool = renderHandoffTool(config, 'ja', 'en');

    expect(tool.type).toBe('handoff');
    expect(tool.destinations).toHaveLength(1);
    const [destination] = tool.destinations;
    expect(destination?.type).toBe('assistant');
    expect(destination?.assistantName).toBe('sakura-seikotsuin--en');
    expect(destination?.description).toContain('"English"');
    expect(destination?.description).toContain('"英語"');
    expect(destination?.contextEngineeringPlan).toEqual({ type: 'all' });
  });

  test('en → ja targets the ja-return assistant by name (VP-7 R1), not the call-starting ja assistant, with the Japanese switchKeywords', () => {
    const [destination] = renderHandoffTool(config, 'en', 'ja').destinations;

    expect(destination?.type).toBe('assistant');
    expect(destination?.assistantName).toBe('sakura-seikotsuin--ja-return');
    expect(destination?.description).toContain('"日本語"');
    expect(destination?.description).toContain('"Japanese"');
    // Same rigor as the ja → en direction above — the redirect to ja-return
    // must not silently drop the full-history handoff behavior.
    expect(destination?.contextEngineeringPlan).toEqual({ type: 'all' });
  });

  test('ja → en targets en directly; en → ja is redirected to ja-return, so the two are not symmetric', () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0]?.assistantName;
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0]?.assistantName;

    expect(toEn).toBe('sakura-seikotsuin--en');
    expect(toJa).toBe('sakura-seikotsuin--ja-return');
  });

  test("overrides the destination's firstMessage with its arrival script (placeholders filled)", () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0];
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0];

    // Spoken text uses the VP-6 D phonetic override (namePronunciation.en), not the written name.
    expect(toEn?.assistantOverrides.firstMessage).toContain('Sakura Say-koh-tsoo-in');
    expect(toEn?.assistantOverrides.firstMessage).not.toContain('[[');
    expect(toJa?.assistantOverrides.firstMessage).toBe(
      '日本語で承ります。ご用件をお伺いいたします。',
    );
  });

  test("overrides the destination's endCallMessage with its own goodbye script (placeholders filled)", () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0];
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0];

    // Spoken text uses the VP-6 D phonetic override (namePronunciation.en), not the written name.
    expect(toEn?.assistantOverrides.endCallMessage).toBe(
      'Thank you for your call. Please take care.',
    );
    expect(toJa?.assistantOverrides.endCallMessage).toBe(
      'お電話いただき、誠にありがとうございました。どうぞお大事になさってください。',
    );
    expect(toJa?.assistantOverrides.endCallMessage).not.toContain('[[');
  });

  test('silences the default English filler with an empty request-start message, both directions', () => {
    expect(renderHandoffTool(config, 'ja', 'en').messages).toEqual([
      { type: 'request-start', content: '' },
    ]);
    expect(renderHandoffTool(config, 'en', 'ja').messages).toEqual([
      { type: 'request-start', content: '' },
    ]);
  });

  test('rejects a language that is not supported', () => {
    expect(() => renderHandoffTool(config, 'ja', 'fr')).toThrow(UnsupportedLanguageError);
  });
});

describe('renderArrivalMessage', () => {
  test('is englishGreeting for en and handoffToJapanese for ja — never the call-opening greeting', () => {
    expect(renderArrivalMessage(config, 'en')).toContain('Thank you for calling');
    expect(renderArrivalMessage(config, 'en')).not.toContain('English receptionist');
    expect(renderArrivalMessage(config, 'ja')).toBe('日本語で承ります。ご用件をお伺いいたします。');
    expect(renderArrivalMessage(config, 'ja')).not.toContain('For English');
  });

  test('fails loudly for a language with no arrival script mapped, instead of speaking nothing', () => {
    const french = buildMinimalConfig({ language: 'fr' });

    expect(() => renderArrivalMessage(french, 'fr')).toThrow(MissingArrivalScriptError);
  });
});

describe('language ordering and targets', () => {
  test('the default language always comes first, even when it is not first in `supported`', () => {
    const reordered = {
      ...config,
      languages: { ...config.languages, default: 'ja', supported: ['en', 'ja'] },
    };

    expect(orderedLanguages(reordered)).toEqual(['ja', 'en']);
  });

  test('handoff targets are every other supported language — nothing assumes exactly two', () => {
    const three = {
      ...config,
      languages: { ...config.languages, supported: ['ja', 'en', 'fr'] },
    };

    expect(handoffTargets(three, 'ja')).toEqual(['en', 'fr']);
    expect(handoffTargets(three, 'fr')).toEqual(['ja', 'en']);
    expect(handoffTargets(buildMinimalConfig({ language: 'fr' }), 'fr')).toEqual([]);
  });

  test('handoff tool state names follow <clientId>--<from>--handoff-to-<to>', () => {
    expect(handoffToolStateName(SAKURA_ID, 'ja', 'en')).toBe(
      'sakura-seikotsuin--ja--handoff-to-en',
    );
  });
});

describe('renderSquad', () => {
  test('lists the Japanese assistant first (it starts the call), then English, then ja-return', () => {
    const squad = renderSquad(config, { ja: 'ja-id', en: 'en-id', 'ja-return': 'ja-return-id' });

    expect(squad.name).toBe('sakura-seikotsuin--squad');
    expect(squad.members).toEqual([
      { assistantId: 'ja-id' },
      { assistantId: 'en-id' },
      { assistantId: 'ja-return-id' },
    ]);
  });

  test('throws when an assistant id is missing rather than sending a half-built squad', () => {
    expect(() => renderSquad(config, { ja: 'ja-id' })).toThrow(/"en"/);
  });

  test('throws when only ja-return is missing', () => {
    expect(() => renderSquad(config, { ja: 'ja-id', en: 'en-id' })).toThrow(/"ja-return"/);
  });
});

describe('squad member ids (VP-7 R1 — ja-return)', () => {
  test('a two-language client gets three members: default, other, then "<default>-return" last', () => {
    expect(returnMemberId(config)).toBe('ja-return');
    expect(squadMemberIds(config)).toEqual(['ja', 'en', 'ja-return']);
  });

  test('a single-language client has no return member at all', () => {
    const french = buildMinimalConfig({ language: 'fr' });

    expect(returnMemberId(french)).toBeUndefined();
    expect(squadMemberIds(french)).toEqual(['fr']);
  });

  test('contentLanguageOf maps the return member back to the default language; every other id is its own language', () => {
    expect(contentLanguageOf(config, 'ja')).toBe('ja');
    expect(contentLanguageOf(config, 'en')).toBe('en');
    expect(contentLanguageOf(config, 'ja-return')).toBe('ja');
  });

  test('the return member id generalizes past two languages — always "<default>-return", regardless of how many other languages exist', () => {
    const three = {
      ...config,
      languages: { ...config.languages, supported: ['ja', 'en', 'fr'] },
    };

    expect(squadMemberIds(three)).toEqual(['ja', 'en', 'fr', 'ja-return']);
  });
});
