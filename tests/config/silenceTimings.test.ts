/**
 * The optional per-client `silenceTimings` block: when each caller-silence hook fires, in seconds
 * after the assistant stopped speaking. Omitted = the shared defaults (4 / 9 / 14 / 19 / 31), so a
 * client that never sets it renders exactly as before.
 */
import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { parseClientConfig } from '../../src/config/schema.js';
import { DEFAULT_SILENCE_TIMINGS } from '../../src/config/silenceTimingsSchema.js';
import {
  captureIssues,
  issueAt,
  readSakuraDocument,
  SAKURA_ID,
  withChanges,
} from '../helpers/clientFixtures.js';

const sakura = readSakuraDocument();
const parse = (document: unknown) => parseClientConfig(document, SAKURA_ID);
const issuesOf = (document: unknown) => captureIssues(() => parse(document)).issues;

describe('silenceTimings config', () => {
  test('the shared defaults are 4 / 9 / 14 / 19 / 31 seconds', () => {
    expect(DEFAULT_SILENCE_TIMINGS).toEqual({
      nudgeAfterSeconds: 4,
      firstCheckAfterSeconds: 9,
      secondCheckAfterSeconds: 14,
      announceEndAfterSeconds: 19,
      hangUpAfterSeconds: 31,
    });
  });

  test('Sakura and Kanto set nothing, so they use the defaults', () => {
    expect(loadClient('sakura-seikotsuin').silenceTimings).toBeUndefined();
    expect(loadClient('kanto-city-gas-demo').silenceTimings).toBeUndefined();
  });

  test('techmirai-ai sets 8 / 13 / 18 / 23 / 35', () => {
    expect(loadClient('techmirai-ai').silenceTimings).toEqual({
      nudgeAfterSeconds: 8,
      firstCheckAfterSeconds: 13,
      secondCheckAfterSeconds: 18,
      announceEndAfterSeconds: 23,
      hangUpAfterSeconds: 35,
    });
  });

  test('a partial block keeps the defaults for the fields it leaves out', () => {
    const document = withChanges(sakura, (draft) => {
      draft.silenceTimings = { hangUpAfterSeconds: 60 };
    });

    expect(parse(document).config.silenceTimings).toEqual({
      ...DEFAULT_SILENCE_TIMINGS,
      hangUpAfterSeconds: 60,
    });
  });

  test('timings must be strictly increasing: a step not later than the one before it is an error', () => {
    const document = withChanges(sakura, (draft) => {
      draft.silenceTimings = { nudgeAfterSeconds: 10, firstCheckAfterSeconds: 10 };
    });

    expect(issueAt(issuesOf(document), 'silenceTimings.firstCheckAfterSeconds')).toMatch(
      /later than/,
    );
  });

  test('a default that a partial block pushes out of order is caught too', () => {
    const document = withChanges(sakura, (draft) => {
      draft.silenceTimings = { nudgeAfterSeconds: 20 };
    });

    expect(issueAt(issuesOf(document), 'silenceTimings.firstCheckAfterSeconds')).toMatch(
      /later than/,
    );
  });

  test.each([0, -3, 1001, 2.5])('%s seconds is outside Vapi’s 1–1000 whole seconds', (seconds) => {
    const document = withChanges(sakura, (draft) => {
      draft.silenceTimings = { hangUpAfterSeconds: seconds };
    });

    expect(issueAt(issuesOf(document), 'silenceTimings.hangUpAfterSeconds')).toBeDefined();
  });

  test('a misspelt key inside the block is an error, not silently ignored', () => {
    const document = withChanges(sakura, (draft) => {
      draft.silenceTimings = { nudgeAfterSecond: 8 };
    });

    expect(issuesOf(document).some((issue) => issue.path.startsWith('silenceTimings'))).toBe(true);
  });
});
