/**
 * The vocabulary of call-topic analytics (VP-4). Shared by the tool definition
 * (render.ts), the prompt, and the webhook route, so all three always agree.
 */

/** Topics that are not a FAQ id. Everything else must be one of the client's FAQ ids. */
export const RESERVED_TOPICS = ['other', 'unresolved', 'emergency'] as const;
export const CALL_OUTCOMES = ['resolved', 'unresolved', 'emergency'] as const;

export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** Every topic a call may be tagged with: the client's FAQ ids plus the reserved ones. */
export function allowedTopics(faqIds: readonly string[]): string[] {
  return [...faqIds, ...RESERVED_TOPICS.filter((topic) => !faqIds.includes(topic))];
}
