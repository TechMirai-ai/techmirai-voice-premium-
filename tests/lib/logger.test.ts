import { describe, expect, test, vi } from 'vitest';

import { buildLogRecord, logger } from '../../src/lib/logger.js';
import { PHONE_MASK, VALUE_MASK } from '../../src/lib/redact.js';

describe('logger', () => {
  test('redacts phone numbers in the message', () => {
    const record = buildLogRecord('info', 'callback saved for 090-1234-5678');

    expect(record.message).toContain(PHONE_MASK);
    expect(record.message).not.toContain('090-1234-5678');
  });

  test('redacts personal data in the context', () => {
    const record = buildLogRecord('info', 'callback saved', {
      clientId: 'sakura-seikotsuin',
      callerName: '山田太郎',
      callerPhone: '048-000-0000',
    });

    expect(record.context).toEqual({
      clientId: 'sakura-seikotsuin',
      callerName: VALUE_MASK,
      callerPhone: VALUE_MASK,
    });
  });

  test('records the level and an ISO timestamp', () => {
    const record = buildLogRecord('error', 'boom', undefined, new Date('2026-09-18T00:00:00.000Z'));

    expect(record).toEqual({
      level: 'error',
      time: '2026-09-18T00:00:00.000Z',
      message: 'boom',
    });
  });
});

describe('logger output', () => {
  test('writes nothing while NODE_ENV=test', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    logger.info('hello');

    expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  test('writes one redacted JSON line per call outside tests', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      logger.info('callback saved', { callerPhone: '048-000-0000' });
      logger.debug('details');
      logger.warn('slow response');
      logger.error('request failed');

      expect(log).toHaveBeenCalledTimes(2);
      expect(errorLog).toHaveBeenCalledTimes(2);

      const line = JSON.parse(String(log.mock.calls[0]?.[0])) as {
        level: string;
        context: Record<string, string>;
      };
      expect(line.level).toBe('info');
      expect(line.context.callerPhone).toBe(VALUE_MASK);
    } finally {
      vi.restoreAllMocks();
      process.env.NODE_ENV = previous;
    }
  });
});
