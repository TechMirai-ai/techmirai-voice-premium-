/**
 * Gets a finished call's transcript and audio back from Vapi, for the developer archive (VP-12).
 *
 * The end-of-call-report carries a *presigned* recording link that expires (VAPI-FACTS.md VP-12), so
 * the inline attempt uses it directly but a retry hours later cannot rely on it. The fallback is the
 * authenticated `GET /call/{id}/mono-recording`. A 404 there means the call has no recording, which
 * is a normal outcome (`undefined`), not an error to retry forever.
 *
 * Error messages carry HTTP statuses only — never the API key or a (signed) URL.
 */
import { z } from 'zod';

import type { ArchiveAudio, ArchiveSource } from './archive.js';

export const VAPI_API_BASE = 'https://api.vapi.ai';
/** A 12-hour call at 16 kHz mono is far larger than this; refuse rather than exhaust serverless memory. */
export const MAX_AUDIO_BYTES = 200 * 1024 * 1024;
const DEFAULT_MIME_TYPE = 'audio/wav';

export interface VapiAccess {
  apiKey: string;
  fetch?: typeof fetch;
}

export interface VapiCallData {
  transcript: string;
  startedAt?: string | undefined;
  endedReason?: string | undefined;
  presignedMonoUrl?: string | undefined;
}

const callSchema = z.looseObject({
  startedAt: z.string().optional(),
  endedReason: z.string().optional(),
  artifact: z
    .looseObject({
      transcript: z.string().optional(),
      presignedMonoUrl: z.string().optional(),
    })
    .optional(),
});

export async function fetchCallData(callId: string, access: VapiAccess): Promise<VapiCallData> {
  const fetchFn = access.fetch ?? fetch;
  const response = await fetchFn(`${VAPI_API_BASE}/call/${encodeURIComponent(callId)}`, {
    headers: { authorization: `Bearer ${access.apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`Vapi call lookup failed with HTTP ${response.status}.`);
  }
  const parsed = callSchema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new Error('Vapi call lookup returned an unexpected response.');

  const call = parsed.data;
  return {
    transcript: call.artifact?.transcript ?? '',
    startedAt: call.startedAt,
    endedReason: call.endedReason,
    presignedMonoUrl: call.artifact?.presignedMonoUrl,
  };
}

async function readAudio(response: Response): Promise<ArchiveAudio> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_AUDIO_BYTES) throw new Error('The recording is too large to archive.');

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_AUDIO_BYTES) throw new Error('The recording is too large to archive.');

  const mimeType = (response.headers.get('content-type') ?? DEFAULT_MIME_TYPE)
    .split(';')[0]
    ?.trim();
  return { bytes, mimeType: mimeType || DEFAULT_MIME_TYPE };
}

export function buildArchiveSource(
  callId: string,
  data: VapiCallData,
  access: VapiAccess,
): ArchiveSource {
  const fetchFn = access.fetch ?? fetch;

  async function fetchAudio(): Promise<ArchiveAudio | undefined> {
    // 1. The presigned link: no auth needed, but it may have expired by now.
    if (data.presignedMonoUrl) {
      try {
        const response = await fetchFn(data.presignedMonoUrl);
        if (response.ok) return await readAudio(response);
      } catch (error) {
        if (error instanceof Error && /too large/i.test(error.message)) throw error;
        // Network trouble or an expired link: fall through to the authenticated endpoint.
      }
    }

    // 2. The authenticated endpoint (works any time; 404 = the call has no recording).
    const response = await fetchFn(
      `${VAPI_API_BASE}/call/${encodeURIComponent(callId)}/mono-recording`,
      { headers: { authorization: `Bearer ${access.apiKey}` } },
    );
    if (response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(`Vapi recording download failed with HTTP ${response.status}.`);
    }
    return readAudio(response);
  }

  return {
    transcript: data.transcript,
    startedAt: data.startedAt,
    endedReason: data.endedReason,
    fetchAudio,
  };
}
