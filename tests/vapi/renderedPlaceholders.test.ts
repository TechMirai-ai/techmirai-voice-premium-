/**
 * No `[[...]]` placeholder may survive into anything the caller can HEAR from a rendered tool, hook
 * or fixed greeting. A live `request_consultation` failure message once carried a literal
 * `[[contactEmail]]` because that tool line was filled by a function that does not know the
 * placeholder (found in call 01a1e78d, 2026-11-18). The system prompt is deliberately not checked:
 * it contains instruction-only placeholders such as `[[number]]`.
 */
import { describe, expect, test } from 'vitest';

import { loadClient } from '../../src/config/loadClient.js';
import { listClientIds } from '../../src/config/knownClient.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import type { ReservationService } from '../../src/repositories/reservationServiceRepository.js';
import { renderAssistant } from '../../src/vapi/render.js';
import { squadMemberIds } from '../../src/vapi/squad.js';

const PLACEHOLDER = /\[\[[^\]]*\]\]/g;

const SERVICES: ReservationService[] = [
  { id: 'svc-1', name: { ja: 'サービス', en: 'Service' }, durationMinutes: 30 },
];

/** Every `{type, content}` message of a tool payload, as a flat list of strings. */
function toolMessages(payload: unknown): string[] {
  const messages = (payload as { messages?: { content?: string }[] }).messages ?? [];
  return messages.map((message) => message.content ?? '');
}

describe.each(listClientIds())('%s: rendered caller-facing text', (clientId) => {
  const config = loadClient(clientId);

  test.each(squadMemberIds(config))(
    'member %s has no unfilled [[...]] placeholder',
    async (member) => {
      const faq = await new FileKnowledgeSource().listFaq(clientId);
      const rendered = renderAssistant(config, member, faq, {
        baseUrl: 'https://example.test',
        credentialId: 'cred-1',
        services: SERVICES,
        outcomeOutputId: 'out-1',
      });

      const spoken: string[] = [
        rendered.assistant.firstMessage,
        rendered.assistant.endCallMessage ?? '',
        ...toolMessages(rendered.tool),
        ...toolMessages(rendered.topicTool),
        ...rendered.handoffTools.flatMap((handoff) => toolMessages(handoff.payload)),
        ...rendered.reservationTools.flatMap((reservation) => toolMessages(reservation.payload)),
        ...(rendered.transferTool ? toolMessages(rendered.transferTool) : []),
        JSON.stringify(rendered.assistant.hooks),
      ];

      const leftovers = spoken.flatMap((text) => text.match(PLACEHOLDER) ?? []);
      expect(leftovers).toEqual([]);
    },
  );
});
