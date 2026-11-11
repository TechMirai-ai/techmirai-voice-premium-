/**
 * Caller adaptation ("read the room"): one prompt section that picks a single delivery adjustment
 * (rushed / needs repetition / upset). The main risk is the prompt inviting contradictory
 * behaviour, so these tests pin the "exactly one" rule, the tie-break, the guard rails, and that
 * older overlapping guidance no longer says something different.
 */
import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { callerAdaptationSection } from '../../src/vapi/promptExtraSections.js';
import { buildSystemPrompt } from '../../src/vapi/promptTemplate.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

const knowledge = new FileKnowledgeSource();
const KANTO_ID = 'kanto-city-gas-demo';
const HEADING = 'Reading the caller (adapting your delivery):';

describe('callerAdaptationSection', () => {
  test('is one section covering exactly the three situations', () => {
    const sections = callerAdaptationSection(loadClient(SAKURA_ID));

    expect(sections).toHaveLength(1);
    const text = sections[0] ?? '';
    expect(text.match(/^- /gm)).toHaveLength(3);
    expect(text).toContain('- Rushed');
    expect(text).toContain('- Needs repetition');
    expect(text).toContain('- Upset');
  });

  test('demands one adjustment, a fixed tie-break, and no stacking or alternating', () => {
    const text = callerAdaptationSection(loadClient(SAKURA_ID))[0] ?? '';

    expect(text).toContain('at most ONE of the three adjustments');
    expect(text).toContain('pick the single most dominant signal');
    expect(text).toContain('the order is Upset, then Needs repetition, then Rushed');
    expect(text).toContain('Never apply two adjustments in the same reply');
    expect(text).toContain('never alternate between them');
  });

  test('keeps required steps and honesty intact', () => {
    const text = callerAdaptationSection(loadClient(SAKURA_ID))[0] ?? '';

    expect(text).toContain('They never let you skip a required step');
    expect(text).toContain('confirming a name or contact number');
    expect(text).toContain('never means skipping an explicit yes');
    expect(text).not.toContain('Fewer confirmations');
  });

  test('tool-only, silent and exact-wording turns stay untouched; hours and offer-once rules unchanged', () => {
    const text = callerAdaptationSection(loadClient(SAKURA_ID))[0] ?? '';

    expect(text).toContain(
      'must contain only a tool call, must be silent, or must use exact wording',
    );
    expect(text).toContain('add no apology or acknowledgement there');
    expect(text).toContain('a language handoff, ending the call');
    expect(text).toContain('Hours, staff-reachable rules and offer-once rules are unchanged');
  });

  test("Upset: one acknowledgement that counts as the call's sympathy line, no unverified fault, required order kept", () => {
    const text = callerAdaptationSection(loadClient(SAKURA_ID))[0] ?? '';

    expect(text).toContain("it is the call's one and only apology line");
    expect(text).toContain('in your first reply after you notice it');
    expect(text).toContain('never use apology or sympathy wording again for the rest of the call');
    expect(text).toContain('not when they raise a new complaint point');
    expect(text).toContain('a state you stay aware of, not an event you react to again each turn');
    expect(text).toContain('a new angry statement is NOT a fresh trigger');
    expect(text).toContain('it is a single short sentence');
    expect(text).toContain('From your second reply onward, never use apology or sympathy wording');
    expect(text).toContain('申し訳');
    expect(text).toContain('Never promise what staff will do');
    expect(text).toContain('limits only wording you add yourself');
    expect(text).toContain('fixed lines that another rule tells you to say as written');
    expect(text).toContain('do not admit fault that has not been verified');
    expect(text).toContain('Required steps still happen, in their required order');
    expect(text).not.toContain('ahead of the usual order of the script');
  });

  test('Needs repetition: repeats as a statement, never merged with a confirmation question, no address read-back', () => {
    const text = callerAdaptationSection(loadClient(SAKURA_ID))[0] ?? '';

    expect(text).toContain('as a statement, not an extra question');
    expect(text).toContain("never replaces or merges with a flow's own confirmation question");
    expect(text).toContain('a spoken address is read back only if the caller asks');
    expect(text).not.toContain('elderly');
  });

  test('mentions the emergency path only for a client that has one', () => {
    expect(callerAdaptationSection(loadClient(SAKURA_ID))[0]).not.toMatch(/emergency/i);
    expect(callerAdaptationSection(loadClient(KANTO_ID))[0]).toContain('the safety emergency path');
  });

  test('is language-neutral: names no specific language code in its logic', () => {
    const text = callerAdaptationSection(loadClient(SAKURA_ID))[0] ?? '';

    expect(text).toContain('register of the language of this call');
    expect(text).not.toMatch(/\bja\b|\blang ===/);
  });

  test('points an upset caller who asks for a person at the transfer rules only when transfer is on', () => {
    const base = loadClient(SAKURA_ID);
    const withTransfer = callerAdaptationSection(base)[0] ?? '';
    const withoutTransfer = callerAdaptationSection({ ...base, transfer: undefined })[0] ?? '';

    expect(withTransfer.includes('Staff transfer rules apply')).toBe(
      base.transfer?.enabled === true,
    );
    expect(withoutTransfer).not.toContain('Staff transfer rules apply');
  });
});

describe('buildSystemPrompt — caller adaptation wiring', () => {
  test.each([SAKURA_ID, KANTO_ID])(
    '%s: the section appears exactly once, after style and before leading',
    async (clientId) => {
      const config = loadClient(clientId);
      const language = config.languages.supported[0] ?? 'ja';
      const prompt = buildSystemPrompt(config, language, await knowledge.listFaq(clientId));

      expect(prompt.split(HEADING)).toHaveLength(2);
      const style = prompt.indexOf('How you speak:');
      const reading = prompt.indexOf(HEADING);
      const leading = prompt.indexOf('Leading the call:');
      expect(style).toBeLessThan(reading);
      expect(reading).toBeLessThan(leading);
    },
  );

  test('the older style rule no longer tells the model to go shorter for a confused caller', async () => {
    const config = loadClient(SAKURA_ID);
    const prompt = buildSystemPrompt(config, 'en', await knowledge.listFaq(SAKURA_ID));

    expect(prompt).not.toContain('Go shorter for a caller who seems rushed or confused');
    expect(prompt).toContain('set out under "Reading the caller" below');
  });

  test('no older rule still tells the model to shorten/hurry the call or stay brisk on its own', async () => {
    const config = loadClient(SAKURA_ID);
    const prompt = buildSystemPrompt(config, 'en', await knowledge.listFaq(SAKURA_ID));

    expect(prompt).not.toContain('move the call toward its close faster');
    expect(prompt).not.toContain('stay brisk');
    expect(prompt).toContain('apply no separate shortened-call rule');
  });
});
