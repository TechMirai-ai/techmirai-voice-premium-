/**
 * Thin wrapper around @vapi-ai/server-sdk. This is the only file that imports
 * the SDK directly — render.ts, sync.ts and their tests work against the
 * narrow VapiSyncClient interface below, so sync.ts is fully mockable
 * without touching the real SDK (same pattern as src/db/pool.ts's Queryable).
 *
 * Real call shapes, confirmed against the installed SDK's shipped .d.ts
 * (see docs/VAPI-FACTS.md): `client.tools.update({ id, body })` takes one
 * id+body object, but `client.assistants.update({ id, ...fields })` flattens
 * id into the same object as the fields — the two are NOT symmetric.
 */
import { Vapi, VapiClient } from '@vapi-ai/server-sdk';

import type {
  VapiAssistantPayload,
  VapiCreatedResource,
  VapiFunctionToolPayload,
} from './types.js';

export interface VapiSyncClient {
  tools: {
    create(payload: VapiFunctionToolPayload): Promise<VapiCreatedResource>;
    update(id: string, payload: VapiFunctionToolPayload): Promise<VapiCreatedResource>;
  };
  assistants: {
    create(payload: VapiAssistantPayload): Promise<VapiCreatedResource>;
    update(id: string, payload: VapiAssistantPayload): Promise<VapiCreatedResource>;
  };
}

/**
 * Our narrow VapiFunctionToolPayload turns out to be structurally assignable
 * to the SDK's real (much larger) CreateToolsRequest union as-is — no cast
 * needed, TypeScript checks it at the `return` statement below.
 */
function toCreateToolsRequest(payload: VapiFunctionToolPayload): Vapi.CreateToolsRequest {
  return payload;
}

/**
 * Unlike tools, `exactOptionalPropertyTypes` makes CreateAssistantDto's
 * `T | undefined`-typed optional fields structurally incompatible with a
 * plain object literal — this cast is the one place that gap is bridged.
 */
function toCreateAssistantDto(payload: VapiAssistantPayload): Vapi.CreateAssistantDto {
  return payload as unknown as Vapi.CreateAssistantDto;
}

export function createVapiClient(apiKey: string): VapiSyncClient {
  const client = new VapiClient({ token: apiKey });

  return {
    tools: {
      create: (payload) => client.tools.create(toCreateToolsRequest(payload)),
      update: (id, payload) =>
        client.tools.update({
          id,
          body: toCreateToolsRequest(payload),
        }),
    },
    assistants: {
      create: (payload) => client.assistants.create(toCreateAssistantDto(payload)),
      update: (id, payload) =>
        client.assistants.update({
          id,
          ...toCreateAssistantDto(payload),
        } as unknown as Vapi.UpdateAssistantDto),
    },
  };
}
