/**
 * What `vapi:sync` would do for TechMirai's own client, from its real client.yaml: a dry run
 * (zero API calls, nothing written) that lists only `techmirai-ai--…` objects, with the
 * consultation tool instead of the callback tool and no transfer tool.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ReservationServiceRepository } from '../../src/repositories/reservationServiceRepository.js';
import type { VapiSyncClient } from '../../src/vapi/client.js';
import { SquadPrerequisiteError, syncClient, syncSquad } from '../../src/vapi/sync.js';

const CLIENT_ID = 'techmirai-ai';
const NO_SERVICES: ReservationServiceRepository = { listByClient: () => Promise.resolve([]) };

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'tmvp-techmirai-sync-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
});
afterEach(() => rmSync(repoRoot, { recursive: true, force: true }));

function neverCalledClient(): VapiSyncClient {
  const fail = vi.fn(() => Promise.reject(new Error('a dry run must not call Vapi')));
  return {
    tools: { create: fail, update: fail },
    assistants: { create: fail, update: fail },
    squads: { create: fail, update: fail },
    structuredOutputs: { create: fail, update: fail },
  };
}

const dryRun = (member: string) =>
  syncClient(CLIENT_ID, member, {
    dryRun: true,
    client: neverCalledClient(),
    baseUrl: 'https://example.invalid',
    credentialId: 'credential-uuid',
    services: NO_SERVICES,
    repoRoot,
  });

describe('vapi:sync dry run for techmirai-ai', () => {
  test.each(['ja', 'ja-return', 'en'])(
    'member %s plans only techmirai-ai objects, a consultation tool and no transfer tool',
    async (member) => {
      const result = await dryRun(member);

      const names = [
        result.outcomeOutput,
        result.tool,
        result.topicTool,
        ...result.handoffTools,
        ...result.reservationTools,
        ...result.transferTools,
        result.assistant,
      ].map((resource) => resource.name);
      expect(names.every((name) => name.startsWith('techmirai-ai--'))).toBe(true);
      expect(result.tool.name).toBe(`techmirai-ai--${member}--request-consultation`);
      expect(names.some((name) => /request-callback|transfer-call/.test(name))).toBe(false);
      expect(result.transferTools).toEqual([]);
      expect(result.reservationTools).toEqual([]);
      // Nothing exists yet: every object is a create.
      expect([result.tool, result.assistant].every((r) => r.action === 'create')).toBe(true);
    },
  );

  test('the squad cannot be planned before the assistants exist (nothing is touched)', async () => {
    await expect(
      syncSquad(CLIENT_ID, { dryRun: true, client: neverCalledClient(), repoRoot }),
    ).rejects.toBeInstanceOf(SquadPrerequisiteError);
  });
});
