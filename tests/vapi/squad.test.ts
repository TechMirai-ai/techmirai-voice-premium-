import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import {
  MissingArrivalScriptError,
  handoffTargets,
  handoffToolStateName,
  orderedLanguages,
  renderArrivalMessage,
  renderHandoffTool,
  renderSquad,
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

  test('en → ja targets the Japanese assistant by name, with the Japanese switchKeywords', () => {
    const [destination] = renderHandoffTool(config, 'en', 'ja').destinations;

    expect(destination?.assistantName).toBe('sakura-seikotsuin--ja');
    expect(destination?.description).toContain('"日本語"');
    expect(destination?.description).toContain('"Japanese"');
  });

  test("the two tools cross-reference each other: each one's target is the other's owner", () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0]?.assistantName;
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0]?.assistantName;

    expect(toEn).toBe('sakura-seikotsuin--en');
    expect(toJa).toBe('sakura-seikotsuin--ja');
  });

  test("overrides the destination's firstMessage with its arrival script (placeholders filled)", () => {
    const toEn = renderHandoffTool(config, 'ja', 'en').destinations[0];
    const toJa = renderHandoffTool(config, 'en', 'ja').destinations[0];

    expect(toEn?.assistantOverrides.firstMessage).toContain('Sakura Seikotsuin');
    expect(toEn?.assistantOverrides.firstMessage).not.toContain('[[');
    expect(toJa?.assistantOverrides.firstMessage).toBe(
      '日本語の受付にお繋ぎしました。ご用件をお聞かせください。',
    );
  });

  test('silences the default English filler with an empty request-start message', () => {
    expect(renderHandoffTool(config, 'ja', 'en').messages).toEqual([
      { type: 'request-start', content: '' },
    ]);
  });

  test('rejects a language that is not supported', () => {
    expect(() => renderHandoffTool(config, 'ja', 'fr')).toThrow(UnsupportedLanguageError);
  });
});

describe('renderArrivalMessage', () => {
  test('is englishGreeting for en and handoffToJapanese for ja — never the call-opening greeting', () => {
    expect(renderArrivalMessage(config, 'en')).toContain('English receptionist');
    expect(renderArrivalMessage(config, 'ja')).toBe(
      '日本語の受付にお繋ぎしました。ご用件をお聞かせください。',
    );
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
  test('lists the Japanese assistant first (it starts the call), then English', () => {
    const squad = renderSquad(config, { ja: 'ja-id', en: 'en-id' });

    expect(squad.name).toBe('sakura-seikotsuin--squad');
    expect(squad.members).toEqual([{ assistantId: 'ja-id' }, { assistantId: 'en-id' }]);
  });

  test('throws when an assistant id is missing rather than sending a half-built squad', () => {
    expect(() => renderSquad(config, { ja: 'ja-id' })).toThrow(/"en"/);
  });
});
