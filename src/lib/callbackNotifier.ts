/**
 * Notification of a new callback request (FUTURE-FEATURES F-2).
 *
 * Saving a callback is the source of truth; notifying staff is a separate,
 * best-effort concern. A new channel (email, LINE) is a new class implementing
 * this interface — never a change to the callback route.
 */
import { summarizeError } from './errorSummary.js';
import { logger } from './logger.js';

/** The fields a notifier may see. Personal data included — a real channel needs it. */
export interface CallbackNotification {
  id: string;
  clientId: string;
  callId: string;
  language: string;
  callerName: string;
  callerPhone: string;
  reason: string | null;
  createdAt: Date;
}

export interface CallbackNotifier {
  notify(callback: CallbackNotification): Promise<void>;
}

/**
 * The only implementation for now: records that a notification WOULD have
 * fired. Logs identifiers only — never the caller's name or phone.
 */
export class LoggingNotifier implements CallbackNotifier {
  notify(callback: CallbackNotification): Promise<void> {
    logger.info('callback notification would fire', {
      callbackId: callback.id,
      clientId: callback.clientId,
      language: callback.language,
    });
    return Promise.resolve();
  }
}

/**
 * Runs a notifier without letting it affect the caller of this function:
 * never throws, never rejects, and reports failures without personal data.
 */
export async function notifySafely(
  notifier: CallbackNotifier,
  callback: CallbackNotification,
): Promise<void> {
  try {
    await notifier.notify(callback);
  } catch (error) {
    logger.error('callback notification failed', {
      callbackId: callback.id,
      clientId: callback.clientId,
      ...summarizeError(error),
    });
  }
}
