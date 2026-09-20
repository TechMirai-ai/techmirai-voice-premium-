import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { generateTestPage } from '../../src/vapi/generateTestPage.js';
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
      { tools: {}, assistants: { 'test-clinic--ja': assistantId } },
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
});
