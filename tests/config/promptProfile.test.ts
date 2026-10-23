/**
 * VP-19: the optional `promptOverrides`, `reservationFlow` and `emergency` sections. Absent, they
 * change nothing (sakura has none of them); present, they are validated like every other block.
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

const validEmergency = {
  label: 'a gas smell',
  triggers: ['I smell gas'],
  script: { ja: 'ガスのにおいがするとのことですね。', en: 'I understand that you smell gas.' },
  callbackReason: 'SAFETY: caller reported possible gas smell/leak',
};

describe('the new sections are optional', () => {
  test('sakura has none of them and still validates', () => {
    expect(sakura.promptOverrides).toBeUndefined();
    expect(sakura.reservationFlow).toBeUndefined();
    expect(sakura.emergency).toBeUndefined();
    expect(() => parse(sakura)).not.toThrow();
  });
});

describe('promptOverrides', () => {
  test('accepts any subset of the known overrides', () => {
    const document = withChanges(sakura, (draft) => {
      draft.promptOverrides = { businessNoun: 'company', staffLabel: 'customer-service staff' };
    });

    expect(parse(document).config.promptOverrides?.businessNoun).toBe('company');
  });

  test('rejects an unknown key, so a typo cannot silently do nothing', () => {
    const document = withChanges(sakura, (draft) => {
      draft.promptOverrides = { businesNoun: 'company' };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'promptOverrides.businesNoun')).toMatch(/unknown key/i);
  });

  test('rejects an empty override', () => {
    const document = withChanges(sakura, (draft) => {
      draft.promptOverrides = { identity: '' };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'promptOverrides.identity')).toBeDefined();
  });
});

describe('reservationFlow', () => {
  test('accepts the simple flow with a service-address question in every language', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = {
        mode: 'simple',
        askServiceAddress: { ja: '住所をお願いします。', en: 'What is the address?' },
      };
    });

    expect(parse(document).config.reservationFlow?.mode).toBe('simple');
  });

  test('rejects an unknown mode', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = { mode: 'fancy' };
    });

    expect(() => parse(document)).toThrow();
  });

  test('requires the address question in every supported language', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = { mode: 'simple', askServiceAddress: { ja: '住所をお願いします。' } };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'reservationFlow.askServiceAddress.en')).toMatch(/missing text/i);
  });

  test('rejects an address question on the patient-types flow, where nothing would ask it', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = {
        mode: 'patient-types',
        askServiceAddress: { ja: '住所をお願いします。', en: 'What is the address?' },
      };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'reservationFlow.askServiceAddress')).toMatch(/simple/);
  });
});

describe('reservationFlow.postalCodeLookup (VP-20)', () => {
  const line = { ja: '日本語', en: 'English' };
  const postalCodeLookup = {
    askPostalCode: line,
    confirmArea: line,
    askBuildingAndRoom: line,
    lookupFailed: line,
  };

  test('accepts the postal-code flow with the spoken address as its fallback', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = { mode: 'simple', askServiceAddress: line, postalCodeLookup };
    });

    expect(parse(document).config.reservationFlow?.postalCodeLookup).toEqual(postalCodeLookup);
  });

  test('rejects it without the fallback address question', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = { mode: 'simple', postalCodeLookup };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'reservationFlow.postalCodeLookup')).toMatch(/askServiceAddress/);
  });

  test('requires every line in every supported language', () => {
    const document = withChanges(sakura, (draft) => {
      draft.reservationFlow = {
        mode: 'simple',
        askServiceAddress: line,
        postalCodeLookup: { ...postalCodeLookup, lookupFailed: { ja: '日本語' } },
      };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'reservationFlow.postalCodeLookup.lookupFailed.en')).toMatch(
      /missing text/i,
    );
  });
});

describe('emergency', () => {
  test('accepts a complete emergency block', () => {
    const document = withChanges(sakura, (draft) => {
      draft.emergency = validEmergency;
    });

    expect(parse(document).config.emergency?.callbackReason).toBe(validEmergency.callbackReason);
  });

  test('requires the fixed wording in every supported language', () => {
    const document = withChanges(sakura, (draft) => {
      draft.emergency = { ...validEmergency, script: { ja: validEmergency.script.ja } };
    });

    const { issues } = captureIssues(() => parse(document));

    expect(issueAt(issues, 'emergency.script.en')).toMatch(/missing text/i);
  });

  test('needs at least one trigger phrase and a callback reason', () => {
    const noTriggers = withChanges(sakura, (draft) => {
      draft.emergency = { ...validEmergency, triggers: [] };
    });
    const noReason = withChanges(sakura, (draft) => {
      draft.emergency = { ...validEmergency, callbackReason: '' };
    });

    expect(
      issueAt(captureIssues(() => parse(noTriggers)).issues, 'emergency.triggers'),
    ).toBeDefined();
    expect(
      issueAt(captureIssues(() => parse(noReason)).issues, 'emergency.callbackReason'),
    ).toBeDefined();
  });
});
