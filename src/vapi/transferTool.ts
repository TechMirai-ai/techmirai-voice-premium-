/**
 * The `transfer_to_staff` function tool (VP-24). Pure — no network, no filesystem.
 *
 * It is a plain function tool whose webhook (src/routes/transferToStaff.ts) runs the hard hours and
 * volume gate and only then starts the transfer through Live Call Control. So the staff number is
 * NOT in this payload (nor anywhere on Vapi): the server reads it from `.env`, and the line spoken
 * when the transfer starts is sent by the server too, in the call's own language.
 *
 * Synced once per language leg only because the sync engine keeps one tool entry per member; the
 * payload is identical for every leg.
 */
import type { ClientConfig } from '../config/schema.js';
import { businessNoun } from './promptShared.js';
import { TRANSFER_TO_STAFF_FUNCTION_NAME } from './toolNames.js';
import type { VapiFunctionToolPayload } from './types.js';

/** The transfer tool's state-file key (`.vapi-state.<clientId>.json`); not sent to Vapi. */
export function transferToolStateName(clientId: string, memberId: string): string {
  return `${clientId}--${memberId}--transfer-call`;
}

/** `undefined` when the client has no `transfer` block or has switched it off. */
export function renderTransferTool(
  config: ClientConfig,
  baseUrl: string,
  credentialId: string,
): VapiFunctionToolPayload | undefined {
  if (!config.transfer?.enabled) return undefined;

  return {
    type: 'function',
    function: {
      name: TRANSFER_TO_STAFF_FUNCTION_NAME,
      description:
        `Connects the caller to a staff member of the ${businessNoun(config)} by phone. Use it ` +
        'only as the transfer rules in the system prompt allow. The system may refuse; then it ' +
        'returns an error.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
    server: { url: `${baseUrl}/api/voice/transfer-to-staff`, credentialId },
    // Silent on purpose: Vapi would otherwise say its own English filler before the call moves.
    // The announcement is the `content` of the transfer command the server sends.
    messages: [
      { type: 'request-start', content: '' },
      { type: 'request-complete', content: '' },
      { type: 'request-failed', content: '' },
    ],
  };
}
