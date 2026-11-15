/** The one-off test-SMS command: preview by default, one real-pipeline send only with --send. Mocks only. */
import { describe, expect, test } from 'vitest';

import { runTestSms, type TestSmsDeps } from '../../src/cli/techmiraiTestSms.js';
import { loadClient } from '../../src/config/loadClient.js';
import type { SmsMessage } from '../../src/notifications/telnyxSms.js';

function harness() {
  const sent: SmsMessage[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const deps: TestSmsDeps = {
    loadConfig: (id) => loadClient(id),
    credential: (name) => (name === 'TELNYX_API_KEY' ? 'key' : undefined),
    sms: {
      send: (message) => {
        sent.push(message);
        return Promise.resolve({ messageId: 'm1' });
      },
    },
    print: (line) => out.push(line),
    printError: (line) => err.push(line),
    now: () => new Date('2026-11-16T03:00:00Z'),
  };
  return { deps, sent, out, err };
}

describe('techmirai:test-sms', () => {
  test('without --send it previews the text and sends nothing', async () => {
    const h = harness();

    const code = await runTestSms(['090-1234-5678'], h.deps);

    expect(code).toBe(0);
    expect(h.sent).toHaveLength(0);
    const printed = h.out.join('\n');
    expect(printed).toContain('From:    TechMirai');
    expect(printed).toContain('Preview only');
    expect(printed).not.toContain('09012345678');
    expect(printed).not.toContain('1234');
  });

  test('with --send it sends exactly one SMS from "TechMirai" through the pipeline, and no LINE', async () => {
    const h = harness();

    const code = await runTestSms(['090-1234-5678', '--language', 'en', '--send'], h.deps);

    expect(code).toBe(0);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ from: 'TechMirai', to: '+819012345678' });
    expect(h.sent[0]?.text).toContain('Please do not reply');
    expect(h.sent[0]).toMatchObject({
      messagingProfileId: '4001a195-9a6f-4a6b-8c61-c4c1d09caf3d',
    });
    expect(h.out.join('\n')).toContain('RESULT: SENT');
    expect(h.out.join('\n')).toContain('message id m1');
    expect(h.out.join('\n')).toContain('Profile: 4001a195-9a6f-4a6b-8c61-c4c1d09caf3d');
    expect(h.out.join('\n')).not.toContain('09012345678');
  });

  test.each(['03-1234-5678', '+14155550100', 'abc', ''])(
    'refuses %j (not a Japanese mobile) and sends nothing',
    async (number) => {
      const h = harness();

      const code = await runTestSms([number, '--send'], h.deps);

      expect(code).toBe(1);
      expect(h.sent).toHaveLength(0);
    },
  );

  test('refuses an unsupported language, and a missing number prints the usage', async () => {
    const h = harness();

    expect(await runTestSms(['09012345678', '--language', 'fr', '--send'], h.deps)).toBe(1);
    expect(await runTestSms([], h.deps)).toBe(1);
    expect(h.err.join('\n')).toContain('Usage: npm run techmirai:test-sms');
    expect(h.sent).toHaveLength(0);
  });

  test('reports "not sent" when the pipeline skips it (e.g. no credential)', async () => {
    const h = harness();
    h.deps.credential = () => undefined;

    const code = await runTestSms(['09012345678', '--send'], h.deps);

    expect(code).toBe(1);
    expect(h.sent).toHaveLength(0);
    expect(h.err.join('\n')).toContain('RESULT: NOT SENT');
    expect(h.err.join('\n')).toContain('missing_credentials');
  });
});
