import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { ClientConfigError, loadClient } from '../../src/config/loadClient.js';
import {
  captureIssues,
  issueAt,
  readSakuraDocument,
  SAKURA_ID,
  withChanges,
  writeClientFixture,
  type ClientFixture,
} from '../helpers/clientFixtures.js';

let fixture: ClientFixture | undefined;

afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe('loadClient', () => {
  test('loads the demo client from the real clients directory', () => {
    expect(loadClient(SAKURA_ID).clientId).toBe(SAKURA_ID);
  });

  test.each([
    '../etc',
    '../../etc/passwd',
    '/etc/passwd',
    'sakura-seikotsuin/../../etc',
    '..',
    '.',
    'Sakura-Seikotsuin',
    'sakura seikotsuin',
    'sakura$(whoami)',
    '',
  ])('rejects %j as a client id instead of touching the filesystem', (clientId) => {
    const { issues } = captureIssues(() => loadClient(clientId));

    expect(issueAt(issues, 'clientId')).toMatch(/not a valid client id/);
  });

  test('reports a missing config file clearly', () => {
    expect(() => loadClient('no-such-clinic')).toThrow(ClientConfigError);
    expect(() => loadClient('no-such-clinic')).toThrow(/no config found at/);
  });

  test('reports invalid YAML instead of crashing', () => {
    fixture = writeClientFixture('broken-clinic', {});
    writeFileSync(`${fixture.clientsDir}/broken-clinic/client.yaml`, 'a:\n  - b\n c: [', 'utf8');

    const { issues } = captureIssues(() =>
      loadClient('broken-clinic', { clientsDir: fixture!.clientsDir }),
    );

    expect(issueAt(issues, '(file)')).toMatch(/invalid YAML/);
  });

  test('refuses a client folder that is a symlink pointing outside clients/', () => {
    // A valid-looking slug whose folder is really a link to somewhere else.
    fixture = writeClientFixture('real-clinic', readSakuraDocument());
    const outside = path.join(tmpdir(), `tmvp-outside-${Date.now()}`);
    mkdirSync(path.join(outside, 'escaped-clinic'), { recursive: true });
    writeFileSync(path.join(outside, 'escaped-clinic', 'client.yaml'), 'clientId: escaped\n');
    symlinkSync(path.join(outside, 'escaped-clinic'), `${fixture.clientsDir}/escaped-clinic`);

    const { issues } = captureIssues(() =>
      loadClient('escaped-clinic', { clientsDir: fixture!.clientsDir }),
    );

    expect(issueAt(issues, 'clientId')).toMatch(/outside the clients directory/);
  });

  test('requires the clientId in the file to match the folder it lives in', () => {
    const document = withChanges(readSakuraDocument(), (draft) => {
      draft.clientId = 'sakura-seikotsuin';
    });
    fixture = writeClientFixture('other-clinic', document);

    const { issues } = captureIssues(() =>
      loadClient('other-clinic', { clientsDir: fixture!.clientsDir }),
    );

    expect(issueAt(issues, 'clientId')).toMatch(/expected "other-clinic"/);
  });
});
