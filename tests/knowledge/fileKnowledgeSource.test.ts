import { describe, expect, test } from 'vitest';

import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import { SAKURA_ID } from '../helpers/clientFixtures.js';

describe('FileKnowledgeSource', () => {
  const source = new FileKnowledgeSource();

  test('returns every FAQ entry for the demo client', async () => {
    const entries = await source.listFaq(SAKURA_ID);

    expect(entries).toHaveLength(10);
    expect(entries.map((entry) => entry.id)).toContain('hours');
  });

  test('returns entries shaped like FaqEntry, in every supported language', async () => {
    const [first] = await source.listFaq(SAKURA_ID);

    expect(first).toBeDefined();
    expect(Object.keys(first!).sort()).toEqual(['answer', 'id', 'question', 'tags']);
    expect(Object.keys(first!.question).sort()).toEqual(['en', 'ja']);
    expect(first!.tags.length).toBeGreaterThan(0);
  });

  test('hands out copies, so callers cannot mutate the loaded config', async () => {
    const [first] = await source.listFaq(SAKURA_ID);
    first!.tags.push('mutated');

    const [again] = await source.listFaq(SAKURA_ID);

    expect(again!.tags).not.toContain('mutated');
  });

  test('rejects an invalid client id', async () => {
    await expect(source.listFaq('../etc')).rejects.toThrow(/not a valid client id/);
  });
});
