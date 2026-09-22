import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { StateFileAssistantResolver } from '../../src/vapi/assistantResolver.js';
import { writeState } from '../../src/vapi/stateStore.js';
import {
  readSakuraDocument,
  SAKURA_ID,
  writeClientFixture,
  type ClientFixture,
} from '../helpers/clientFixtures.js';

let fixture: ClientFixture;
let repoRoot: string;
let resolver: StateFileAssistantResolver;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-resolver-'));
  fixture = writeClientFixture(SAKURA_ID, readSakuraDocument());
  writeState(
    SAKURA_ID,
    {
      tools: {},
      assistants: { [`${SAKURA_ID}--ja`]: 'id-ja', [`${SAKURA_ID}--en`]: 'id-en' },
      squads: {},
    },
    { repoRoot },
  );
  resolver = new StateFileAssistantResolver({ clientsDir: fixture.clientsDir, repoRoot });
});

afterEach(() => {
  fixture.cleanup();
  rmSync(repoRoot, { recursive: true, force: true });
});

describe('StateFileAssistantResolver', () => {
  test('resolves by assistant id through the state file', () => {
    expect(resolver.resolve({ id: 'id-en' })).toEqual({ clientId: SAKURA_ID, language: 'en' });
  });

  test('resolves by assistant name when there is no id', () => {
    expect(resolver.resolve({ name: `${SAKURA_ID}--ja` })).toEqual({
      clientId: SAKURA_ID,
      language: 'ja',
    });
  });

  test('resolves when id and name agree', () => {
    expect(resolver.resolve({ id: 'id-ja', name: `${SAKURA_ID}--ja` })).toEqual({
      clientId: SAKURA_ID,
      language: 'ja',
    });
  });

  test('refuses when the id belongs to a different assistant than the name claims', () => {
    expect(resolver.resolve({ id: 'id-en', name: `${SAKURA_ID}--ja` })).toBeUndefined();
  });

  test.each([
    ['an unknown id', { id: 'nope' }],
    ['an unknown name', { name: 'other-clinic--ja' }],
    ['a language the client does not support', { name: `${SAKURA_ID}--fr` }],
    ['nothing at all', {}],
  ])('returns undefined for %s', (_label, ref) => {
    expect(resolver.resolve(ref)).toBeUndefined();
  });

  test('returns undefined when the clients directory does not exist', () => {
    const missing = new StateFileAssistantResolver({ clientsDir: path.join(repoRoot, 'nope') });

    expect(missing.resolve({ name: `${SAKURA_ID}--ja` })).toBeUndefined();
  });

  test('sees a fresh sync without a restart (state is read on every lookup)', () => {
    expect(resolver.resolve({ id: 'id-new' })).toBeUndefined();

    writeState(
      SAKURA_ID,
      { tools: {}, assistants: { [`${SAKURA_ID}--ja`]: 'id-new' }, squads: {} },
      { repoRoot },
    );

    expect(resolver.resolve({ id: 'id-new' })).toEqual({ clientId: SAKURA_ID, language: 'ja' });
  });
});
