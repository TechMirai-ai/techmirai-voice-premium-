/**
 * VP-26: the prompt section for acknowledging a returning caller's last visit. Present only for a
 * client that opts in (`reservationFlow.recall`) and has bookable services — the tool it names is
 * rendered under the same conditions (render.ts), so the prompt never mentions a tool the assistant
 * does not have, and a client without it renders byte-identically.
 *
 * What the caller hears is the client's own wording (`reservationFlow.recall.scripts`); everything
 * else here is English instruction to the model, the same for every client. The privacy-relevant
 * limits are enforced by the server (src/routes/recallLastVisit.ts returns only a date and a
 * service); this text keeps the model from adding to it or implying a history that does not exist.
 */
import type { RecallScriptKey } from '../config/recallSchema.js';
import type { ClientConfig } from '../config/schema.js';
import type { ReservationService } from '../repositories/reservationServiceRepository.js';
import { fillClinicPlaceholders, pick } from './promptShared.js';
import { RECALL_LAST_VISIT_FUNCTION_NAME } from './toolNames.js';

const RECALL = RECALL_LAST_VISIT_FUNCTION_NAME;

/**
 * Recall is live only when the client opted in AND has bookable services: the tool is rendered
 * under the same condition (render.ts), so the prompt must never name it otherwise.
 */
export function isRecallActive(config: ClientConfig, services: ReservationService[]): boolean {
  return config.reservationFlow?.recall !== undefined && services.length > 0;
}

export function recallSection(
  config: ClientConfig,
  language: string,
  services: ReservationService[],
): string[] {
  const recall = config.reservationFlow?.recall;
  if (!recall || !isRecallActive(config, services)) return [];

  /** One of the client's recall lines, clinic placeholders filled; `[[date]]`/`[[service]]` are the model's to fill. */
  const line = (key: RecallScriptKey): string =>
    `"${fillClinicPlaceholders(config, language, pick(recall.scripts[key], language))}"`;

  return [
    [
      'Acknowledging an earlier visit: callers are recognised by the phone number they are calling ' +
        `from. On your first reply of the call — after the caller has said what they need, or right ` +
        `away if they only greeted you — call ${RECALL} once (it takes no arguments, and you never ` +
        'ask for, repeat or accept a phone number or name for it). Do not announce that you are ' +
        'checking. Skip it if the caller is reporting an emergency or an urgent safety matter.',
      `1. If it returns an earlier booking: before carrying on with what the caller asked, say ${line('visitAcknowledgement')} ` +
        'once — filling [[date]] with the date in the language you are speaking (naturally, never ' +
        'as digits like 2026-10-01) and [[service]] with the service, never speaking the ' +
        `placeholder text itself. If the result says "service not recorded", say ${line('visitAcknowledgementNoService')} ` +
        'instead.',
      "It is a booking in the clinic's records, not proof the caller came: never call it a visit, " +
        'never say the caller visited or attended, and never add "welcome back" of your own. If you ' +
        'have already welcomed the caller back in this call, do not repeat it.',
      "2. Say only the date and the service. Never say the time, the caller's name, a reservation " +
        'number, or anything about what was done, how it went or their condition. If the caller ' +
        'asks for more details about that visit, say you cannot go into details by phone and offer ' +
        'a staff callback, following the callback steps above.',
      '3. If it says no earlier visit is on record, or gives an error, or you are unsure, say ' +
        'nothing about earlier visits and carry on exactly as for a new caller. Never claim, imply ' +
        'or guess that the caller has been here before, and never say you remember them.',
      'At most ONE line about an earlier contact is spoken per call. If you said the visit ' +
        'acknowledgement, it takes priority: do not also add a line about an earlier call from ' +
        'the earlier-call section below.',
    ].join('\n'),
  ];
}
