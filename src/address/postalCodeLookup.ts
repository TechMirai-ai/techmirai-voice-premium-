/**
 * Japanese postal-code → prefecture / city / town, via zipcloud's free public API (VP-20).
 *
 * Verified live 2026-10-23: `GET https://zipcloud.ibsnet.co.jp/api/search?zipcode=<7 digits>`,
 * no key. It answers HTTP 200 for everything — the real outcome is the body's `status`:
 * 200 with `results` (found), 200 with `results: null` (unknown code), 400 with a Japanese
 * `message` (bad parameter). Kana come back half-width, so they are NFKC-normalised here.
 * Every failure mode is mapped to a result kind; nothing here throws, so a lookup problem can
 * never break a call (the prompt falls back to a spoken address).
 *
 * The postal code is never logged: callers log outcome kinds only.
 */
import { z } from 'zod';

const ZIPCLOUD_URL = 'https://zipcloud.ibsnet.co.jp/api/search';
const LOOKUP_TIMEOUT_MS = 4000;
const POSTAL_CODE_PATTERN = /^\d{7}$/;
/** zipcloud's own filler for a postal code that covers a whole municipality. */
const TOWN_NOT_LISTED = '以下に掲載がない場合';

export interface PostalAddress {
  prefecture: string;
  city: string;
  /** Empty when the code covers the whole city. */
  town: string;
  prefectureKana: string;
  cityKana: string;
  townKana: string;
}

export type PostalCodeLookupResult =
  | { kind: 'found'; addresses: PostalAddress[] }
  | { kind: 'not_found' }
  | { kind: 'invalid' }
  | { kind: 'unavailable' };

export interface PostalCodeLookup {
  lookup(rawPostalCode: string): Promise<PostalCodeLookupResult>;
}

const rowSchema = z.object({
  address1: z.string(),
  address2: z.string(),
  address3: z.string(),
  kana1: z.string(),
  kana2: z.string(),
  kana3: z.string(),
});

const responseSchema = z.object({
  status: z.number(),
  results: z.array(rowSchema).nullable().optional(),
});

/** "〒150-0002", "１５０ー０００２" → "1500002"; anything not exactly 7 digits → undefined. */
export function normalizePostalCode(raw: string): string | undefined {
  const digits = raw.normalize('NFKC').replace(/[\s〒\-ー‐−]/g, '');
  return POSTAL_CODE_PATTERN.test(digits) ? digits : undefined;
}

/** "1500002" → "150-0002", the way a postal code is written. */
export function formatPostalCode(digits: string): string {
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}

/** zipcloud appends notes such as "渋谷（１～５丁目）" (blocks 1-5) — not part of the spoken name. */
function withoutNote(text: string): string {
  return text.replace(/[（(].*[）)]\s*$/, '').trim();
}

function toAddress(row: z.infer<typeof rowSchema>): PostalAddress {
  const isTownListed = row.address3 !== TOWN_NOT_LISTED;
  return {
    prefecture: row.address1,
    city: row.address2,
    town: isTownListed ? withoutNote(row.address3) : '',
    prefectureKana: row.kana1.normalize('NFKC'),
    cityKana: row.kana2.normalize('NFKC'),
    townKana: isTownListed ? withoutNote(row.kana3.normalize('NFKC')) : '',
  };
}

export class ZipcloudPostalCodeLookup implements PostalCodeLookup {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async lookup(rawPostalCode: string): Promise<PostalCodeLookupResult> {
    const postalCode = normalizePostalCode(rawPostalCode);
    if (!postalCode) return { kind: 'invalid' };

    try {
      const response = await this.fetchImpl(`${ZIPCLOUD_URL}?zipcode=${postalCode}`, {
        signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) return { kind: 'unavailable' };

      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success) return { kind: 'unavailable' };

      const { status, results } = parsed.data;
      if (status === 400) return { kind: 'invalid' };
      if (status !== 200) return { kind: 'unavailable' };
      if (!results || results.length === 0) return { kind: 'not_found' };
      return { kind: 'found', addresses: results.map(toAddress) };
    } catch {
      // Timeout, DNS, connection reset, bad JSON — all the same to the caller: fall back.
      return { kind: 'unavailable' };
    }
  }
}
