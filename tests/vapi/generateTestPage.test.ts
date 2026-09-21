import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { generateTestPage, parseTestPageArgs } from '../../src/vapi/generateTestPage.js';
import { writeState } from '../../src/vapi/stateStore.js';

describe('generateTestPage', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-genpage-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const syncAssistant = (assistantId: string): void =>
    writeState(
      'test-clinic',
      { tools: {}, assistants: { 'test-clinic--ja': assistantId }, squads: {} },
      { repoRoot },
    );

  test('writes a static page and script with the assistant id and public key baked in', () => {
    syncAssistant('assistant-uuid');

    const result = generateTestPage({
      clientId: 'test-clinic',
      language: 'ja',
      publicKey: 'pub-key',
      repoRoot,
    });

    expect(result.htmlPath).toBe(
      path.join(repoRoot, 'public', 'vapi-test-call', 'test-clinic--ja.html'),
    );
    expect(result.urlPath).toBe('/vapi-test-call/test-clinic--ja.html');
    expect(readFileSync(result.htmlPath, 'utf8')).toContain('/vapi-test-call/test-clinic--ja.js');
    const script = readFileSync(result.scriptPath, 'utf8');
    expect(script).toContain('"assistant-uuid"');
    expect(script).toContain('"pub-key"');
  });

  test('regenerating after a re-sync picks up the new assistant id', () => {
    syncAssistant('old-id');
    generateTestPage({ clientId: 'test-clinic', language: 'ja', publicKey: 'k', repoRoot });
    syncAssistant('new-id');

    const result = generateTestPage({
      clientId: 'test-clinic',
      language: 'ja',
      publicKey: 'k',
      repoRoot,
    });

    const script = readFileSync(result.scriptPath, 'utf8');
    expect(script).toContain('"new-id"');
    expect(script).not.toContain('"old-id"');
  });

  test('throws with sync guidance when no assistant has been synced', () => {
    expect(() =>
      generateTestPage({ clientId: 'test-clinic', language: 'ja', publicKey: 'k', repoRoot }),
    ).toThrow(/vapi:sync/);
  });

  test('rejects ids that could escape the output directory, writing nothing', () => {
    expect(() =>
      generateTestPage({ clientId: '../evil', language: 'ja', publicKey: 'k', repoRoot }),
    ).toThrow(/Invalid clientId/);
    expect(existsSync(path.join(repoRoot, 'public'))).toBe(false);
  });

  describe('squad target (default)', () => {
    const syncSquadId = (squadId: string): void =>
      writeState(
        'test-clinic',
        {
          tools: {},
          assistants: { 'test-clinic--ja': 'assistant-uuid' },
          squads: { 'test-clinic--squad': squadId },
        },
        { repoRoot },
      );

    test('with no language, bakes the squad id (not an assistant id) into <clientId>--squad', () => {
      syncSquadId('squad-uuid');

      const result = generateTestPage({ clientId: 'test-clinic', publicKey: 'pub-key', repoRoot });

      expect(result.urlPath).toBe('/vapi-test-call/test-clinic--squad.html');
      const script = readFileSync(result.scriptPath, 'utf8');
      expect(script).toContain('squad: "squad-uuid"');
      expect(script).not.toContain('assistant-uuid');
    });

    test('throws with squad-sync guidance when no squad has been synced, even if an assistant has', () => {
      syncAssistant('assistant-uuid');

      expect(() => generateTestPage({ clientId: 'test-clinic', publicKey: 'k', repoRoot })).toThrow(
        /--squad --apply/,
      );
    });
  });
});

describe('parseTestPageArgs', () => {
  test('a bare client id means the squad page', () => {
    expect(parseTestPageArgs(['sakura-seikotsuin'])).toEqual({ clientId: 'sakura-seikotsuin' });
  });

  test('--language selects a single assistant, in either argument order', () => {
    expect(parseTestPageArgs(['sakura-seikotsuin', '--language', 'ja'])).toEqual({
      clientId: 'sakura-seikotsuin',
      language: 'ja',
    });
    expect(parseTestPageArgs(['--language', 'en', 'sakura-seikotsuin'])).toEqual({
      clientId: 'sakura-seikotsuin',
      language: 'en',
    });
  });

  test('rejects a missing client id and a --language with no value', () => {
    expect(parseTestPageArgs([])).toBeUndefined();
    expect(parseTestPageArgs(['--language', 'ja'])).toBeUndefined();
    expect(parseTestPageArgs(['sakura-seikotsuin', '--language'])).toBeUndefined();
    expect(parseTestPageArgs(['sakura-seikotsuin', '--language', '--apply'])).toBeUndefined();
  });
});
