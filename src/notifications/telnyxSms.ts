/**
 * Sends one SMS through Telnyx's `POST /v2/messages`.
 *
 * Verified 2026-11-02 against developers.telnyx.com (docs/NOTIFICATION-FACTS.md): Bearer auth;
 * `messaging_profile_id` is REQUIRED when `from` is an alphanumeric sender ID; success is
 * `{ data: { id, to: [{ status }] } }`; an `Idempotency-Key` header makes a retry safe.
 *
 * Which key, profile and sender to use is the caller's business (per-client config) — this class
 * holds no client data and no secrets.
 */
import {
  fetchWithTimeout,
  NOTIFICATION_TIMEOUT_MS,
  NotificationDeliveryError,
} from './deliveryError.js';

export const TELNYX_MESSAGES_URL = 'https://api.telnyx.com/v2/messages';

export interface SmsMessage {
  apiKey: string;
  messagingProfileId: string;
  /** Alphanumeric sender ID or E.164 number. */
  from: string;
  /** E.164. */
  to: string;
  text: string;
  /** Letters, digits, hyphens, underscores (Telnyx's rule); same key = same message. */
  idempotencyKey: string;
}

export interface SmsSender {
  send(message: SmsMessage): Promise<{ messageId: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Telnyx puts a numeric error code in `errors[0].code`; the rest of the body may echo the number. */
function providerErrorCode(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.errors)) return undefined;
  const first: unknown = body.errors[0];
  if (!isRecord(first)) return undefined;
  const raw = first.code;
  const code = typeof raw === 'string' || typeof raw === 'number' ? String(raw) : '';
  return /^\d{1,8}$/.test(code) ? code : undefined;
}

export class TelnyxSmsSender implements SmsSender {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = NOTIFICATION_TIMEOUT_MS,
  ) {}

  async send(message: SmsMessage): Promise<{ messageId: string }> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      TELNYX_MESSAGES_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${message.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: message.to,
          text: message.text,
          messaging_profile_id: message.messagingProfileId,
          type: 'SMS',
        }),
      },
      this.timeoutMs,
    );

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const code = providerErrorCode(body);
      throw new NotificationDeliveryError(
        code ? `http_${response.status}_${code}` : `http_${response.status}`,
      );
    }

    const data = isRecord(body) ? body.data : undefined;
    const id = isRecord(data) ? data.id : undefined;
    if (typeof id !== 'string' || id === '') throw new NotificationDeliveryError('bad_response');
    return { messageId: id };
  }
}
