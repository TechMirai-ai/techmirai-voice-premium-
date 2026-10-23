/**
 * What the model is told after `lookup_postal_code` (VP-20). Shared by the webhook and the text
 * tester so both give the model exactly the same words. Every non-found outcome tells it to fall
 * back to a spoken address — a failed lookup must never leave the caller stuck.
 */
import type { PostalAddress, PostalCodeLookupResult } from './postalCodeLookup.js';

export interface LookupReply {
  isError: boolean;
  text: string;
}

const FALLBACK =
  'Do not retry with a guessed code. Tell the caller you could not look it up automatically ' +
  'and ask for their full address instead.';

function describe(address: PostalAddress, index: number): string {
  const part = (label: string, value: string, kana: string): string =>
    value ? `${label}: ${value} (reading: ${kana})` : '';
  const parts = [
    part('prefecture', address.prefecture, address.prefectureKana),
    part('city', address.city, address.cityKana),
    part('town', address.town, address.townKana),
  ].filter(Boolean);
  return `${index + 1}) ${parts.join('; ')}.`;
}

export function lookupReply(result: PostalCodeLookupResult): LookupReply {
  switch (result.kind) {
    case 'found': {
      const matches = result.addresses.map(describe).join(' ');
      const advice =
        result.addresses.length > 1
          ? 'Several areas share this postal code: read the options and let the caller pick.'
          : 'Read the area back to the caller and ask whether it is right.';
      return {
        isError: false,
        text: `Found ${result.addresses.length} match(es). ${matches} ${advice}`,
      };
    }
    case 'not_found':
      return { isError: true, text: `No area exists for that postal code. ${FALLBACK}` };
    case 'invalid':
      return {
        isError: true,
        text: `That is not a valid 7-digit postal code. Ask the caller to repeat it once; if it is still not valid, or they do not know it: ${FALLBACK}`,
      };
    case 'unavailable':
      return { isError: true, text: `The postal-code service is unavailable. ${FALLBACK}` };
  }
}
