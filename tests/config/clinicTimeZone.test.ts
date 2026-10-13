import { describe, expect, test, vi } from 'vitest';

import { clinicTimeZoneLookup } from '../../src/config/clinicTimeZone.js';
import type { ClientConfig } from '../../src/config/schema.js';

const configWith = (timezone: string): ClientConfig =>
  ({ business: { hours: { timezone } } }) as unknown as ClientConfig;

describe('clinicTimeZoneLookup', () => {
  test('returns the client’s business.hours.timezone', () => {
    const lookup = clinicTimeZoneLookup(() => configWith('Asia/Tokyo'));
    expect(lookup('sakura-seikotsuin')).toBe('Asia/Tokyo');
  });

  test('reads each client’s config only once', () => {
    const load = vi.fn(() => configWith('Asia/Tokyo'));
    const lookup = clinicTimeZoneLookup(load);

    lookup('a');
    lookup('a');
    lookup('b');

    expect(load).toHaveBeenCalledTimes(2);
  });

  test('the real demo client resolves to Asia/Tokyo from clients/<id>/client.yaml', () => {
    expect(clinicTimeZoneLookup()('sakura-seikotsuin')).toBe('Asia/Tokyo');
  });
});
