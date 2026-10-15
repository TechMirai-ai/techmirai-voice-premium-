/**
 * POST /api/voice/silence-end — the `silence_end_call` tool's endpoint (VP-16 R3).
 *
 * Called by the silence-escalation hook once the caller has stayed silent through every check. It
 * speaks the ending announcement and hangs up in ONE Live Call Control command
 * (`say` + `endCallAfterSpoken`), because a hook's own `say` followed by `endCall` makes the
 * standard `endCallMessage` goodbye play on top of the announcement (VAPI-FACTS.md VP-16 R2).
 * Nothing personal is read, stored or logged: only the call id and Vapi's own control address.
 */
import { Router } from 'express';

import { loadClient } from '../config/loadClient.js';
import { logger } from '../lib/logger.js';
import { silenceEndingLine } from '../vapi/callEnding.js';
import type { AssistantResolver } from '../vapi/assistantResolver.js';
import { SILENCE_END_CALL_FUNCTION_NAME } from '../vapi/toolNames.js';
import { errorResult, okResult } from '../vapi/toolCallsMessage.js';
import { toolWebhook } from './voiceWebhook.js';

export const SILENCE_END_PATH = '/silence-end';

const CONTROL_REQUEST_TIMEOUT_MS = 5_000;
const VAPI_HOST_SUFFIX = '.vapi.ai';

export interface SilenceEndRouteDeps {
  resolver: AssistantResolver;
  /** For tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * The control address is only ever used if it is an https URL on Vapi's own domain, so a forged or
 * malformed webhook can never make this server call an arbitrary host.
 */
export function isVapiControlUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith(VAPI_HOST_SUFFIX);
  } catch {
    return false;
  }
}

export function silenceEndRouter(deps: SilenceEndRouteDeps): Router {
  const router = Router();
  const doFetch = deps.fetchImpl ?? fetch;

  router.post(
    SILENCE_END_PATH,
    toolWebhook({
      toolName: SILENCE_END_CALL_FUNCTION_NAME,
      resolver: deps.resolver,
      handle: async (context, call) => {
        if (!context.controlUrl || !isVapiControlUrl(context.controlUrl)) {
          logger.warn('silence end: no usable control address', {
            clientId: context.clientId,
            callId: context.callId,
          });
          return errorResult(call, 'No control address for this call; nothing was said.');
        }

        const content = silenceEndingLine(loadClient(context.clientId), context.language);
        const response = await doFetch(context.controlUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'say', content, endCallAfterSpoken: true }),
          signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
          logger.error('silence end: control request failed', {
            clientId: context.clientId,
            callId: context.callId,
            status: response.status,
          });
          return errorResult(call, 'The ending announcement could not be sent.');
        }

        logger.info('silence end: announcement sent, hanging up', {
          clientId: context.clientId,
          callId: context.callId,
        });
        return okResult(call, 'Announced and ending the call.');
      },
    }),
  );

  return router;
}
