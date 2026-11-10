/**
 * VP-26: the `recall_last_visit` tool — the assistant acknowledging a returning caller's last
 * visit. The server decides what may be said, never the model:
 *  - the caller's number comes from the call only (`context.callerPhone`); the tool takes no
 *    argument, so nothing the model says can reach another caller's history;
 *  - what leaves this file is the visit's DATE and SERVICE and nothing else (owner decision) —
 *    no time of day, name, reservation number or phone number is ever in the result;
 *  - only a visit within the client's `maxAgeDays` is recalled (default one year);
 *  - "no number", "no visit", "too old" and "lookup failed" all give the SAME answer, so the
 *    assistant treats the caller as new and never implies a history that does not exist;
 *  - it only reads: a failure here can never block or alarm the call.
 *
 * A "visit" is the caller's latest active booking whose time has passed. There is no attendance
 * record, so a booking the caller did not turn up for looks the same — documented in
 * docs/VP26-CRM-RECALL.md.
 *
 * Phone-number matching is not authentication: caller ID can be spoofed, and on the demo /talk page
 * the number is simply typed in. Same accepted limitation as VP-25 (docs/VP25-APPOINTMENT-CHANGES.md).
 *
 * Logs say only whether a visit was found — never the number, the date or the service.
 */
import { Router } from 'express';

import { loadClient } from '../config/loadClient.js';
import { clinicNow, daysBefore } from '../lib/clinicTime.js';
import { summarizeError } from '../lib/errorSummary.js';
import { logger } from '../lib/logger.js';
import type { AppointmentRepository, LastVisit } from '../repositories/appointmentRepository.js';
import type { ReservationServiceRepository } from '../repositories/reservationServiceRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { RECALL_LAST_VISIT_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const RECALL_LAST_VISIT_PATH = '/recall-last-visit';

const NOT_AVAILABLE_FOR_CLIENT =
  'Recalling an earlier visit is not available here. Say nothing about earlier visits and carry ' +
  'on with what the caller asked.';
const NO_VISIT =
  'No earlier visit is on record for this caller. Treat them as a new patient: say nothing about ' +
  'earlier visits, never claim or imply they have been here before, and carry on with what they ' +
  'asked.';
const SERVICE_NOT_RECORDED = 'service not recorded';

export interface RecallLastVisitRouteDeps {
  resolver: AssistantResolver;
  appointments: AppointmentRepository;
  services: ReservationServiceRepository;
  /** The clock; tests pin it. */
  now?: () => Date;
}

/** The service in the call's own language when the catalogue still has it, else the stored text. */
async function serviceNameOf(
  visit: LastVisit,
  clientId: string,
  language: string,
  services: ReservationServiceRepository,
): Promise<string | null> {
  if (visit.serviceId) {
    const catalogue = await services.listByClient(clientId);
    const name = catalogue.find((service) => service.id === visit.serviceId)?.name[language];
    if (name) return name;
  }
  return visit.serviceName;
}

/** A service name is catalogue text today, but it is read back to the model: keep it one short line. */
const MAX_SERVICE_CHARS = 100;
const boundedService = (service: string | null): string | null => {
  const oneLine = service?.replace(/\s+/g, ' ').trim().slice(0, MAX_SERVICE_CHARS);
  return oneLine ? oneLine : null;
};

const visitText = (date: string, service: string | null): string =>
  `Earlier booking on record: ${date}, service: ${boundedService(service) ?? SERVICE_NOT_RECORDED}. Say only the ` +
  'date and the service, in one sentence, in the language you are speaking; leave the service ' +
  'out if it says "service not recorded". Present it only as a booking in the clinic\'s records, ' +
  'never as a visit or as the caller having attended — attendance is not recorded. Never say a ' +
  'time, a name, a reservation number or anything about what was done.';

export function recallLastVisitRouter(deps: RecallLastVisitRouteDeps): Router {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  router.post(
    RECALL_LAST_VISIT_PATH,
    toolWebhook({
      toolName: RECALL_LAST_VISIT_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const config = loadClient(context.clientId);
        const recall = config.reservationFlow?.recall;
        if (!recall) return errorResult(call, NOT_AVAILABLE_FOR_CLIENT);
        // `callerPhone` is undefined — never the demo placeholder — when the call carried no number.
        if (!context.callerPhone) return okResult(call, NO_VISIT);

        const today = clinicNow(config.business.hours.timezone, now());
        let text = NO_VISIT;
        let found = false;
        try {
          const visit = await deps.appointments.findLastVisit(
            context.clientId,
            context.callerPhone,
            today,
            daysBefore(today.date, recall.maxAgeDays),
          );
          if (visit) {
            const service = await serviceNameOf(
              visit,
              context.clientId,
              context.language,
              deps.services,
            );
            text = visitText(visit.appointmentDate, service);
            found = true;
          }
        } catch (error) {
          // A failed lookup must never block the call: the caller is simply treated as new.
          logger.error('recall_last_visit failed', {
            clientId: context.clientId,
            callId: context.callId,
            ...summarizeError(error),
          });
        }

        logger.info('recall_last_visit', {
          clientId: context.clientId,
          callId: context.callId,
          found,
        });
        return okResult(call, text);
      },
    }),
  );

  return router;
}
