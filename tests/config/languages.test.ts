/**
 * Proves FUTURE-FEATURES F-6 readiness: adding a language is a config change,
 * never a code change — and the schema refuses a half-translated config.
 */
import { afterEach, describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { parseClientConfig } from '../../src/config/schema.js';
import {
  captureIssues,
  issueAt,
  readSakuraDocument,
  withChanges,
  writeClientFixture,
  type ClientFixture,
} from '../helpers/clientFixtures.js';

const FIXTURE_ID = 'trilingual-clinic';
const NEW_LANGUAGE = 'pt-BR';

const sakura = readSakuraDocument();

/** Copies every localized block's Japanese text into the new language. */
function addThirdLanguage(draft: Record<string, any>): void {
  draft.clientId = FIXTURE_ID;
  draft.languages.supported = [...draft.languages.supported, NEW_LANGUAGE];
  draft.languages.settings[NEW_LANGUAGE] = {
    voice: { provider: 'azure', voiceId: 'pt-BR-FranciscaNeural' },
    transcriber: null,
    switchKeywords: ['Português'],
  };

  draft.business.name[NEW_LANGUAGE] = 'Clínica Sakura';
  draft.business.address[NEW_LANGUAGE] = 'Sample-cho 1-2-3, Saitama';

  for (const key of Object.keys(draft.scripts)) {
    draft.scripts[key][NEW_LANGUAGE] = draft.scripts[key].en;
  }
  for (const entry of draft.faq) {
    entry.question[NEW_LANGUAGE] = entry.question.en;
    entry.answer[NEW_LANGUAGE] = entry.answer.en;
  }
}

let fixture: ClientFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe('adding a third language', () => {
  test('fails, naming every missing text, when only `supported` is extended', () => {
    const document = withChanges(sakura, (draft) => {
      draft.languages.supported = [...draft.languages.supported, NEW_LANGUAGE];
    });

    const { issues } = captureIssues(() => parseClientConfig(document, 'sakura-seikotsuin'));
    const paths = issues.map((issue) => issue.path);

    expect(issueAt(issues, `languages.settings.${NEW_LANGUAGE}`)).toMatch(/missing settings/i);
    expect(paths).toContain(`business.name.${NEW_LANGUAGE}`);
    expect(paths).toContain(`scripts.greeting.${NEW_LANGUAGE}`);
    expect(paths).toContain(`faq[0].answer.${NEW_LANGUAGE}`);
    // one per script + two per FAQ entry + business name/address + settings
    expect(paths.length).toBeGreaterThan(30);
  });

  test('passes once every script and FAQ entry has the new text', () => {
    const document = withChanges(sakura, addThirdLanguage);
    fixture = writeClientFixture(FIXTURE_ID, document);

    const config = loadClient(FIXTURE_ID, { clientsDir: fixture.clientsDir });

    expect(config.languages.supported).toEqual(['ja', 'en', NEW_LANGUAGE]);
    expect(config.scripts.greeting[NEW_LANGUAGE]).toBeTruthy();
    expect(config.faq.every((entry) => entry.answer[NEW_LANGUAGE])).toBe(true);
  });

  test('rejects text for a language that is not in `supported`', () => {
    const document = withChanges(sakura, (draft) => {
      draft.scripts.goodbye.de = 'Auf Wiedersehen.';
    });

    const { issues } = captureIssues(() => parseClientConfig(document, 'sakura-seikotsuin'));

    expect(issueAt(issues, 'scripts.goodbye.de')).toContain('not in languages.supported');
  });
});
