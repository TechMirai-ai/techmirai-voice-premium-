/**
 * Cross-field rules for the `transfer` section of client.yaml (VP-24).
 *
 * Which languages need text is handled for the spoken lines by `rules.ts` (the transfer scripts are
 * registered as localized blocks there, so they get the same completeness and placeholder checks
 * as every other script). This file holds what is specific to a live phone transfer:
 *
 *  - closed dates must be real calendar days,
 *  - a transfer needs the callback flow (the safety net when a transfer cannot be completed),
 *  - spoken text must not contain Liquid syntax, which Vapi would evaluate.
 */
import type { ConfigIssue } from './issues.js';
import type { ClientConfig } from './schema.js';
import { TRANSFER_SCRIPT_KEYS } from './transferSchema.js';

/** Vapi renders `{{ }}` / `{% %}` in prompts and messages; client text must never open either. */
const LIQUID_PATTERN = /\{\{|\{%/;

function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** `2026-02-30` matches the date pattern but is not a day. */
function isRealCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function transferIssues(config: ClientConfig): ConfigIssue[] {
  const transfer = config.transfer;
  if (!transfer) return [];

  const issues: ConfigIssue[] = [];

  // The number lives in `.env` (transfer.numberEnv), so its country code is checked when the
  // server reads it (src/lib/transferGate.ts), not here.

  transfer.closedDates.forEach((date, index) => {
    if (!isRealCalendarDate(date)) {
      issues.push({
        path: `transfer.closedDates.${index}`,
        message: 'is not a real calendar date',
      });
    }
  });

  if (transfer.enabled) {
    for (const [day, hours] of Object.entries(config.business.hours.weekly)) {
      if (hours === 'closed') continue;
      const open = minutesOf(hours.open);
      const close = minutesOf(hours.close);
      if (close <= open) {
        issues.push({
          path: `business.hours.weekly.${day}`,
          message:
            'closes at or before it opens (overnight hours): the transfer gate never allows a transfer on this day',
        });
      } else if (close - open <= transfer.closingBufferMinutes) {
        issues.push({
          path: 'transfer.closingBufferMinutes',
          message: `is not shorter than the ${day} opening window: the transfer gate would refuse all day`,
        });
      }
    }
  }

  if (transfer.enabled && !config.callback.enabled) {
    issues.push({
      path: 'transfer.enabled',
      message:
        'needs callback.enabled — the callback request is the safety net when a transfer cannot be completed',
    });
  }

  for (const [path, text] of transferTexts(config)) {
    if (LIQUID_PATTERN.test(text)) {
      issues.push({ path, message: 'must not contain "{{" or "{%" — Vapi would evaluate it' });
    }
  }

  return issues;
}

/** Every spoken string in the section, with its path. */
function transferTexts(config: ClientConfig): [string, string][] {
  const transfer = config.transfer;
  if (!transfer) return [];
  const scripts = TRANSFER_SCRIPT_KEYS.flatMap((key) =>
    Object.entries(transfer.scripts[key]).map(([code, text]): [string, string] => [
      `transfer.scripts.${key}.${code}`,
      text,
    ]),
  );
  const fallback = Object.entries(transfer.fallbackPlan?.message ?? {}).map(
    ([code, text]): [string, string] => [`transfer.fallbackPlan.message.${code}`, text],
  );
  return [...scripts, ...fallback];
}
