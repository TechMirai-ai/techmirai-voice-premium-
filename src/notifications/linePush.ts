/**
 * Sends one text message to one LINE recipient through the Messaging API's push endpoint
 * (`POST /v2/bot/message/push` — NOT broadcast).
 *
 * Verified live 2026-11-02 for a userId (docs/NOTIFICATION-FACTS.md L1): Bearer channel access
 * token; success is HTTP 200 `{ sentMessages: [{ id }] }`. `to` may also be a groupId on the same
 * endpoint (so moving staff to a group is a config change) — from LINE's docs, NOT yet exercised
 * live (L4).
 *
 * Which token and recipient to use is the caller's business (per-client config).
 */
import {
  fetchWithTimeout,
  NOTIFICATION_TIMEOUT_MS,
  NotificationDeliveryError,
} from './deliveryError.js';

export const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

export interface LinePushMessage {
  accessToken: string;
  /** A LINE userId (`U` + 32 hex) or groupId (`C` + 32 hex). */
  to: string;
  text: string;
  /** LINE requires a UUID; the same key within 24 hours will not be delivered twice. */
  retryKey: string;
}

export interface LinePusher {
  push(message: LinePushMessage): Promise<{ messageId?: string }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class LineMessagingPusher implements LinePusher {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs: number = NOTIFICATION_TIMEOUT_MS,
  ) {}

  async push(message: LinePushMessage): Promise<{ messageId?: string }> {
    const response = await fetchWithTimeout(
      this.fetchImpl,
      LINE_PUSH_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${message.accessToken}`,
          'Content-Type': 'application/json',
          'X-Line-Retry-Key': message.retryKey,
        },
        body: JSON.stringify({
          to: message.to,
          messages: [{ type: 'text', text: message.text }],
        }),
      },
      this.timeoutMs,
    );

    // Never read the error body into the code: LINE's text can quote the recipient id.
    if (!response.ok) throw new NotificationDeliveryError(`http_${response.status}`);

    const body: unknown = await response.json().catch(() => undefined);
    const sent: unknown =
      isRecord(body) && Array.isArray(body.sentMessages) ? body.sentMessages[0] : undefined;
    const id: unknown = isRecord(sent) ? sent.id : undefined;
    return typeof id === 'string' ? { messageId: id } : {};
  }
}
