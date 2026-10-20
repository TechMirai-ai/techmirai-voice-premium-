/**
 * VP-19 regression guard: sakura-seikotsuin's rendered Vapi payloads must not change when shared
 * prompt/render code is extended for another client. The golden file was captured from the code as
 * it stood before VP-19. Regenerate deliberately (UPDATE_GOLDEN=1 npx vitest run
 * tests/vapi/sakuraGolden.test.ts) only when a change to sakura's assistants is intended.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import type { ReservationService } from '../../src/repositories/reservationServiceRepository.js';
import { renderCallOutcomeOutput } from '../../src/vapi/callReporting.js';
import { renderAssistant } from '../../src/vapi/render.js';
import { REPO_ROOT, SAKURA_ID } from '../helpers/clientFixtures.js';

const GOLDEN_PATH = path.join(REPO_ROOT, 'tests', 'fixtures', 'sakura-render-golden.json');

const SERVICES: ReservationService[] = [
  {
    id: 'general-consultation',
    name: { ja: '一般施術', en: 'General Consultation' },
    durationMinutes: 30,
  },
  {
    id: 'sports-injury',
    name: { ja: 'スポーツ外傷施術', en: 'Sports Injury Treatment' },
    durationMinutes: 45,
  },
];

async function renderEverything(): Promise<unknown> {
  const config = loadClient(SAKURA_ID);
  const faq = await new FileKnowledgeSource().listFaq(SAKURA_ID);
  const options = {
    baseUrl: 'https://example.test',
    credentialId: 'cred-1',
    services: SERVICES,
    outcomeOutputId: 'out-1',
  };
  const members = [...config.languages.supported, `${config.languages.default}-return`];
  return {
    members: Object.fromEntries(
      members.map((id) => [id, renderAssistant(config, id, faq, options)]),
    ),
    callOutcome: renderCallOutcomeOutput(config, faq),
  };
}

describe('sakura-seikotsuin rendered payloads (golden)', () => {
  test('are identical to the pre-VP-19 capture', async () => {
    const actual = JSON.parse(JSON.stringify(await renderEverything())) as unknown;

    if (process.env['UPDATE_GOLDEN'] === '1' || !existsSync(GOLDEN_PATH)) {
      writeFileSync(GOLDEN_PATH, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    }

    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN_PATH, 'utf8')));
  });
});
