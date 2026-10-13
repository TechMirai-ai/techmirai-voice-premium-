import { loadClient } from './loadClient.js';
import type { ClientConfig } from './schema.js';

/** A client's `business.hours.timezone` (IANA name). */
export type TimeZoneLookup = (clientId: string) => string;

/** Reads each client's timezone from its client.yaml once and remembers it. */
export function clinicTimeZoneLookup(
  load: (clientId: string) => ClientConfig = loadClient,
): TimeZoneLookup {
  const cache = new Map<string, string>();
  return (clientId) => {
    const cached = cache.get(clientId);
    if (cached) return cached;
    const timeZone = load(clientId).business.hours.timezone;
    cache.set(clientId, timeZone);
    return timeZone;
  };
}
