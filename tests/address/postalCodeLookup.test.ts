/**
 * VP-20: the zipcloud client. The response shapes below are the ones observed live on 2026-10-23
 * (see src/address/postalCodeLookup.ts): HTTP 200 for every outcome, the real status in the body.
 */
import { describe, expect, test } from 'vitest';

import { lookupReply } from '../../src/address/lookupReply.js';
import {
  formatPostalCode,
  normalizePostalCode,
  ZipcloudPostalCodeLookup,
} from '../../src/address/postalCodeLookup.js';

const SHIBUYA_ROW = {
  address1: '東京都',
  address2: '渋谷区',
  address3: '渋谷',
  kana1: 'ﾄｳｷｮｳﾄ',
  kana2: 'ｼﾌﾞﾔｸ',
  kana3: 'ｼﾌﾞﾔ',
  prefcode: '13',
  zipcode: '1500002',
};

function fakeFetch(body: unknown, init: { ok?: boolean } = {}) {
  const urls: string[] = [];
  const impl = ((url: string) => {
    urls.push(url);
    return Promise.resolve({ ok: init.ok ?? true, json: () => Promise.resolve(body) });
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe('normalizePostalCode', () => {
  test.each([
    ['1500002', '1500002'],
    ['150-0002', '1500002'],
    ['〒150-0002', '1500002'],
    ['１５０ー０００２', '1500002'],
    [' 150 0002 ', '1500002'],
  ])('%s → %s', (raw, expected) => {
    expect(normalizePostalCode(raw)).toBe(expected);
  });

  test.each(['', '12', '150000', '15000022', 'abcdefg', '150-00o2'])(
    'rejects %j as not a 7-digit code',
    (raw) => {
      expect(normalizePostalCode(raw)).toBeUndefined();
    },
  );

  test('formatPostalCode writes three digits, a hyphen, four digits', () => {
    expect(formatPostalCode('1500002')).toBe('150-0002');
  });
});

describe('ZipcloudPostalCodeLookup', () => {
  test('returns the prefecture, city and town, with kana normalised to full width', async () => {
    const { impl, urls } = fakeFetch({ message: null, results: [SHIBUYA_ROW], status: 200 });

    const result = await new ZipcloudPostalCodeLookup(impl).lookup('150-0002');

    expect(urls).toEqual(['https://zipcloud.ibsnet.co.jp/api/search?zipcode=1500002']);
    expect(result).toEqual({
      kind: 'found',
      addresses: [
        {
          prefecture: '東京都',
          city: '渋谷区',
          town: '渋谷',
          prefectureKana: 'トウキョウト',
          cityKana: 'シブヤク',
          townKana: 'シブヤ',
        },
      ],
    });
  });

  test('treats the "not listed" town filler as no town', async () => {
    const { impl } = fakeFetch({
      message: null,
      status: 200,
      results: [{ ...SHIBUYA_ROW, address3: '以下に掲載がない場合', kana3: 'ｲｶﾆｹｲｻｲｶﾞﾅｲﾊﾞｱｲ' }],
    });

    const result = await new ZipcloudPostalCodeLookup(impl).lookup('1500002');

    expect(result).toMatchObject({ kind: 'found', addresses: [{ town: '', townKana: '' }] });
  });

  test('drops zipcloud notes such as "（１～５丁目）" from the town and its reading', async () => {
    const { impl } = fakeFetch({
      message: null,
      status: 200,
      results: [{ ...SHIBUYA_ROW, address3: '渋谷（１～５丁目）', kana3: 'ｼﾌﾞﾔ(1-5ﾁｮｳﾒ)' }],
    });

    const result = await new ZipcloudPostalCodeLookup(impl).lookup('1500002');

    expect(result).toMatchObject({
      kind: 'found',
      addresses: [{ town: '渋谷', townKana: 'シブヤ' }],
    });
  });

  test('returns every area when several share one postal code', async () => {
    const { impl } = fakeFetch({
      message: null,
      status: 200,
      results: [SHIBUYA_ROW, { ...SHIBUYA_ROW, address3: '宇田川町' }],
    });

    const result = await new ZipcloudPostalCodeLookup(impl).lookup('1500002');

    expect(result.kind === 'found' && result.addresses.map((a) => a.town)).toEqual([
      '渋谷',
      '宇田川町',
    ]);
  });

  test('an unknown code (results: null) is not_found', async () => {
    const { impl } = fakeFetch({ message: null, results: null, status: 200 });

    expect(await new ZipcloudPostalCodeLookup(impl).lookup('0000000')).toEqual({
      kind: 'not_found',
    });
  });

  test('a malformed code is invalid without calling the service', async () => {
    const { impl, urls } = fakeFetch({});

    expect(await new ZipcloudPostalCodeLookup(impl).lookup('12')).toEqual({ kind: 'invalid' });
    expect(urls).toEqual([]);
  });

  test('a body status of 400 is invalid', async () => {
    const { impl } = fakeFetch({ message: 'パラメータ不正', results: null, status: 400 });

    expect(await new ZipcloudPostalCodeLookup(impl).lookup('1500002')).toEqual({
      kind: 'invalid',
    });
  });

  test.each([
    ['a non-OK HTTP status', fakeFetch({}, { ok: false }).impl],
    ['a body status of 500', fakeFetch({ message: 'x', results: null, status: 500 }).impl],
    ['an unexpected body', fakeFetch({ hello: 'world' }).impl],
    ['a network failure', () => Promise.reject(new Error('ECONNRESET'))],
    ['a timeout', () => Promise.reject(new DOMException('timed out', 'TimeoutError'))],
  ])('%s is unavailable, never a throw', async (_label, impl) => {
    expect(await new ZipcloudPostalCodeLookup(impl).lookup('1500002')).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('lookupReply', () => {
  test('a single match is read back for confirmation', () => {
    const reply = lookupReply({
      kind: 'found',
      addresses: [
        {
          prefecture: '東京都',
          city: '渋谷区',
          town: '渋谷',
          prefectureKana: 'トウキョウト',
          cityKana: 'シブヤク',
          townKana: 'シブヤ',
        },
      ],
    });

    expect(reply.isError).toBe(false);
    expect(reply.text).toContain('prefecture: 東京都 (reading: トウキョウト)');
    expect(reply.text).toContain('town: 渋谷 (reading: シブヤ)');
    expect(reply.text).toContain('ask whether it is right');
  });

  test.each(['not_found', 'invalid', 'unavailable'] as const)(
    '%s is an error that sends the model to the spoken full address',
    (kind) => {
      const reply = lookupReply({ kind });

      expect(reply.isError).toBe(true);
      expect(reply.text).toContain('ask for their full address instead');
    },
  );
});
