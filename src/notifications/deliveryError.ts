/**
 * A notification provider (Telnyx, LINE) could not deliver. Carries only a short reason code —
 * `http_400`, `timeout`, `network_error` — never the provider's response text, which can echo the
 * recipient's phone number or LINE id back at us. The code is what reaches logs and the
 * `notification_log` table.
 */
export class NotificationDeliveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'NotificationDeliveryError';
  }
}

/** The reason code to record for any thrown value. */
export function deliveryErrorCode(error: unknown): string {
  return error instanceof NotificationDeliveryError ? error.code : 'unexpected_error';
}

/** Default per-request ceiling: the caller is waiting on the booking tool while this runs. */
export const NOTIFICATION_TIMEOUT_MS = 4000;

/** `fetch` with a timeout, mapping every transport failure to a coded delivery error. */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    throw new NotificationDeliveryError(timedOut ? 'timeout' : 'network_error');
  }
}
