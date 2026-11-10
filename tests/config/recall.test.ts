/**
 * VP-26: the optional `reservationFlow.recall` section. Absent = off (the opt-in is its presence);
 * present, it is validated like every other spoken block: every supported language, and the
 * placeholders the model fills in.
 */
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
const parse = (document: unknown) => parseClientConfig(document, SAKURA_ID);

const validRecall = {
  scripts: {
    visitAcknowledgement: {
      ja: '前回は[[date]]に[[service]]でご来院いただきました。',
      en: 'Welcome back. I see your last visit was on [[date]] for [[service]].',
    },
    visitAcknowledgementNoService: {
      ja: '前回は[[date]]にご来院いただきました。',
      en: 'Welcome back. I see your last visit was on [[date]].',
    },
  },
};

const withRecall = (recall: unknown) =>
  withChanges(sakura, (draft) => {
    draft.reservationFlow = { ...draft.reservationFlow, recall };
  });

describe('reservationFlow.recall', () => {
  test('sakura opts in and the section validates', () => {
    const recall = parse(sakura).config.reservationFlow?.recall;

    expect(recall).toBeDefined();
    expect(recall?.maxAgeDays).toBe(365);
  });

  test('a client without the section has recall off', () => {
    const document = withChanges(sakura, (draft) => {
      delete draft.reservationFlow.recall;
    });

    expect(parse(document).config.reservationFlow?.recall).toBeUndefined();
  });

  test('maxAgeDays defaults to 365 and may be set', () => {
    expect(parse(withRecall(validRecall)).config.reservationFlow?.recall?.maxAgeDays).toBe(365);
    expect(
      parse(withRecall({ ...validRecall, maxAgeDays: 90 })).config.reservationFlow?.recall
        ?.maxAgeDays,
    ).toBe(90);
  });

  test.each([0, -5, 1.5, 100000])('maxAgeDays %s is rejected', (maxAgeDays) => {
    const { message } = captureIssues(() => parse(withRecall({ ...validRecall, maxAgeDays })));

    expect(message).toMatch(/maxAgeDays/);
  });

  test('both lines are required, and an unknown key is a typo', () => {
    const missing = captureIssues(() =>
      parse(
        withRecall({
          scripts: { visitAcknowledgement: validRecall.scripts.visitAcknowledgement },
        }),
      ),
    );
    expect(missing.message).toMatch(/visitAcknowledgementNoService/);

    const extra = captureIssues(() =>
      parse(
        withRecall({
          scripts: { ...validRecall.scripts, chatAboutTreatment: { ja: 'x', en: 'x' } },
        }),
      ),
    );
    expect(extra.message).toMatch(/chatAboutTreatment/);
  });

  test('every supported language needs text, and no unsupported language may have any', () => {
    const noEnglish = withRecall({
      scripts: {
        ...validRecall.scripts,
        visitAcknowledgement: { ja: validRecall.scripts.visitAcknowledgement.ja },
      },
    });
    const { issues } = captureIssues(() => parse(noEnglish));
    expect(issueAt(issues, 'reservationFlow.recall.scripts.visitAcknowledgement.en')).toMatch(
      /missing text/i,
    );

    const extraLanguage = withRecall({
      scripts: {
        ...validRecall.scripts,
        visitAcknowledgement: { ...validRecall.scripts.visitAcknowledgement, fr: 'Bonjour' },
      },
    });
    expect(
      issueAt(
        captureIssues(() => parse(extraLanguage)).issues,
        'reservationFlow.recall.scripts.visitAcknowledgement.fr',
      ),
    ).toMatch(/not in languages.supported/);
  });

  test('the acknowledgement must say [[date]] and [[service]]; the no-service line must say [[date]] and no [[service]]', () => {
    const lines = (acknowledgement: string, noService: string) =>
      withRecall({
        scripts: {
          visitAcknowledgement: { ja: acknowledgement, en: acknowledgement },
          visitAcknowledgementNoService: { ja: noService, en: noService },
        },
      });
    const issuesOf = (document: unknown) => captureIssues(() => parse(document)).issues;

    expect(
      issueAt(
        issuesOf(lines('Welcome back, last visit [[date]].', 'Last visit [[date]].')),
        'reservationFlow.recall.scripts.visitAcknowledgement.en',
      ),
    ).toMatch(/\[\[service\]\]/);
    expect(
      issueAt(
        issuesOf(lines('Last visit [[date]] for [[service]].', 'Welcome back.')),
        'reservationFlow.recall.scripts.visitAcknowledgementNoService.en',
      ),
    ).toMatch(/\[\[date\]\]/);
    // The literal "[[service]]" would otherwise be spoken when there is no service.
    expect(
      issueAt(
        issuesOf(
          lines('Last visit [[date]] for [[service]].', 'Last visit [[date]] for [[service]].'),
        ),
        'reservationFlow.recall.scripts.visitAcknowledgementNoService.en',
      ),
    ).toMatch(/must not use "\[\[service\]\]"/);
    // [[time]] would widen what is said beyond the approved date + service.
    expect(
      issueAt(
        issuesOf(lines('Last visit [[date]] [[time]] for [[service]].', 'Last visit [[date]].')),
        'reservationFlow.recall.scripts.visitAcknowledgement.en',
      ),
    ).toMatch(/\[\[time\]\]/);
  });
});
