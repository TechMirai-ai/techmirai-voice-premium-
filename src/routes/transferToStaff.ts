/**
 * POST /api/voice/transfer-to-staff — the `transfer_to_staff` tool's endpoint (VP-24).
 *
 * The model asks; this server decides. A request is allowed only if the hard gate
 * (src/lib/transferGate.ts) passes: clinic open (with its closing buffer and closed dates), no
 * transfer yet on this call, the client under its daily cap, and a usable staff number in `.env`.
 * Only then does the server send ONE Live Call Control `transfer` command to the call's own
 * control address (https + `*.vapi.ai` only), with the spoken announcement as its `content`.
 *
 * Every refusal or failure is an `error` result, which the prompt turns into the callback flow —
 * the gate fails closed. The staff number is read here and never logged, echoed to the model, or
 * stored on Vapi. Reasons are logged; the model is only told "not available".
 */
import { Router } from 'express';

import { loadClient } from '../config/loadClient.js';
import { logger } from '../lib/logger.js';
import { evaluateTransferGate } from '../lib/transferGate.js';
import { TransferLedger } from '../lib/transferLedger.js';
import type { TransferCountReader } from '../repositories/callLogRepository.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { fillClinicPlaceholders, pick } from '../vapi/promptShared.js';
import { TRANSFER_TO_STAFF_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { isVapiControlUrl } from './silenceEnd.js';
import { toolWebhook } from './voiceWebhook.js';

export const TRANSFER_TO_STAFF_PATH = '/transfer-to-staff';

const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60_000;

const NOT_AVAILABLE =
  'Transfer to staff is not available right now. Do not call this tool again: say the failed-transfer line and take a callback.';

export interface TransferToStaffRouteDeps {
  resolver: AssistantResolver;
  /** Stored transfers, for the daily cap. */
  transferCounts: TransferCountReader;
  /** Reads a `.env` variable by name; blank counts as unset (`envCredentialLookup`). */
  transferEnv: (name: string) => string | undefined;
  /** For tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** For tests; defaults to the real clock. */
  now?: () => Date;
  /** For tests; defaults to one fresh ledger per router. */
  ledger?: TransferLedger;
}

export function transferToStaffRouter(deps: TransferToStaffRouteDeps): Router {
  const router = Router();
  const doFetch = deps.fetchImpl ?? fetch;
  const clock = deps.now ?? (() => new Date());
  const ledger = deps.ledger ?? new TransferLedger();

  router.post(
    TRANSFER_TO_STAFF_PATH,
    toolWebhook({
      toolName: TRANSFER_TO_STAFF_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        const config = loadClient(context.clientId);
        const transfer = config.transfer;
        const now = clock();
        const log = { clientId: context.clientId, callId: context.callId };

        let storedLast24h: number;
        try {
          storedLast24h = await deps.transferCounts.countTransfersSince(
            context.clientId,
            new Date(now.getTime() - DAY_MS),
          );
        } catch {
          // An unreadable count must not become "no limit".
          logger.error('transfer refused: could not read the daily count', log);
          return errorResult(call, NOT_AVAILABLE);
        }

        const decision = evaluateTransferGate({
          config,
          now,
          numberValue: transfer ? deps.transferEnv(transfer.numberEnv) : undefined,
          callTransfers: ledger.forCall(context.callId),
          clientTransfersLast24h: storedLast24h + ledger.recentCount(context.clientId, now),
        });
        if (!decision.allowed || !transfer) {
          logger.warn('transfer refused', {
            ...log,
            reason: decision.allowed ? 'disabled' : decision.reason,
          });
          return errorResult(call, NOT_AVAILABLE);
        }

        if (!context.controlUrl || !isVapiControlUrl(context.controlUrl)) {
          logger.warn('transfer refused: no usable control address', log);
          return errorResult(call, NOT_AVAILABLE);
        }

        // Recorded BEFORE the request: a duplicate tool call racing this one is refused, and a
        // failed attempt still counts against the call and the cap (fail closed).
        ledger.record(context.clientId, context.callId, now);

        let accepted = false;
        try {
          const response = await doFetch(context.controlUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'transfer',
              destination: { type: 'number', number: decision.number },
              content: fillClinicPlaceholders(
                config,
                context.language,
                pick(transfer.scripts.transferring, context.language),
              ),
            }),
            // A redirect would replay this body (the staff number) to whatever host it names,
            // bypassing the *.vapi.ai check: treat any redirect as a failure.
            redirect: 'error',
            signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
          });
          accepted = response.ok;
          if (!accepted) {
            logger.error('transfer control request failed', { ...log, status: response.status });
          }
        } catch (error) {
          // A timeout is logged apart: Vapi may still have accepted the command late, so the caller
          // can be transferred after hearing the "failed" line (VAPI-FACTS VP-24 R7).
          const timedOut = error instanceof Error && error.name === 'TimeoutError';
          logger.error('transfer control request failed', {
            ...log,
            status: timedOut ? 'timeout (transfer may still happen)' : 'network',
          });
        }
        if (!accepted) return errorResult(call, NOT_AVAILABLE);

        logger.info('transfer started (outcome unconfirmed)', log);
        return okResult(call, 'The transfer has started. Say nothing more.');
      },
    }),
  );

  return router;
}
