import { describe, expect, test } from 'vitest';

import { parseClientConfig } from '../../src/config/schema.js';
import {
  captureIssues,
  issueAt,
  readSakuraDocument,
  SAKURA_ID,
  withChanges,
} from '../helpers/clientFixtures.js';

const sakura = readSakuraDocument();
const parse = (document: unknown, clientId: string = SAKURA_ID) =>
  parseClientConfig(document, clientId);

describe('client config validation', () => {
  test('accepts the unmodified demo config', () => {
    expect(() => parse(sakura)).not.toThrow();
  });

  test('reports the exact path when a script is missing its English text', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.scripts.greeting.en;
    });

    const { issues, message } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'scripts.greeting.en')).toMatch(/missing text/i);
    expect(message).toContain('scripts.greeting.en');
  });

  test('reports the exact path when an FAQ answer is missing its Japanese text', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.faq[3].answer.ja;
    });

    const { issues, message } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'faq[3].answer.ja')).toMatch(/missing text/i);
    expect(message).toContain('faq[3].answer.ja');
  });

  test('rejects an empty string as if it were missing', () => {
    const document = withChanges(sakura, (draft) => {
      draft.scripts.goodbye.ja = '   ';
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'scripts.goodbye.ja')).toMatch(/empty/i);
  });

  test('rejects a duplicated FAQ id and names both entries', () => {
    const document = withChanges(sakura, (draft) => {
      draft.faq[2].id = draft.faq[0].id;
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'faq[2].id')).toMatch(/duplicate FAQ id "hours".*faq\[0\]/);
  });

  test('rejects an unknown placeholder', () => {
    const document = withChanges(sakura, (draft) => {
      draft.scripts.goodbye.en = 'Goodbye from [[foo]].';
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'scripts.goodbye.en')).toContain('[[foo]]');
  });

  test('allows the caller placeholders only in scripts.confirmDetails', () => {
    const document = withChanges(sakura, (draft) => {
      draft.scripts.greeting.en = 'Hello [[callerName]].';
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'scripts.greeting.en')).toContain('scripts.confirmDetails');

    // …and the real config, which uses them inside confirmDetails, is fine.
    expect(() => parse(sakura)).not.toThrow();
  });

  test('rejects a default language that is not supported', () => {
    const document = withChanges(sakura, (draft) => {
      draft.languages.default = 'fr';
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'languages.default')).toContain('not in languages.supported');
  });

  test('rejects a clientId that does not match the folder name', () => {
    const { issues } = captureIssues(() => parse(sakura, 'some-other-clinic'));

    expect(issueAt(issues, 'clientId')).toMatch(/expected "some-other-clinic"/);
  });

  test('rejects a phone number that is not E.164', () => {
    const document = withChanges(sakura, (draft) => {
      draft.business.phone.e164 = '048-000-0000';
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'business.phone.e164')).toContain('E.164');
  });

  test('rejects an unknown key inside a known section, to catch typos', () => {
    const document = withChanges(sakura, (draft) => {
      draft.business.wesbite = 'https://example.com';
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'business.wesbite')).toMatch(/unknown key/i);
  });

  test('allows an unknown top-level section but reports it as a warning (F-4)', () => {
    const document = withChanges(sakura, (draft) => {
      draft.telephony = { provider: 'twilio', number: '+81480000000' };
    });

    const { warnings } = parse(document);

    expect(warnings).toEqual([
      { path: 'telephony', message: expect.stringContaining('unknown top-level section') },
    ]);
  });

  test('still accepts transcriber: null for a client that has not chosen one yet', () => {
    const document = withChanges(sakura, (draft) => {
      draft.languages.settings.ja.transcriber = null;
    });

    const { config } = parse(document);

    expect(config.languages.settings.ja?.transcriber).toBeNull();
  });

  test('accepts the transcriber shape VP-2 actually configures (provider + language)', () => {
    const { config } = parse(sakura);

    expect(config.languages.settings.ja?.transcriber).toEqual({
      provider: 'azure',
      language: 'ja-JP',
    });
  });

  test('collects several problems in one error instead of stopping at the first', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.scripts.greeting.en;
      delete draft.faq[1].question.ja;
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issues.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['scripts.greeting.en', 'faq[1].question.ja']),
    );
  });
});
