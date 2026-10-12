/**
 * The one place that talks HTTP to Google's REST APIs: attaches the bearer token and turns any
 * non-2xx answer into a typed `GoogleApiError`. The error carries the status only — never the
 * response body, which can quote file names or other content from the archive.
 */
import type { AccessTokenProvider } from './auth.js';

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

/** The URL of any `fetch` input, without relying on `String()` of a `Request`. */
export function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** The body of a `fetch` init when it is text (all of our form and JSON bodies are); else ''. */
export function requestBodyText(init: RequestInit | undefined): string {
  return typeof init?.body === 'string' ? init.body : '';
}

export async function googleFetch(
  fetchFn: typeof fetch,
  auth: AccessTokenProvider,
  url: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await auth.getAccessToken();
  const method = init.method ?? 'GET';
  const host = new URL(url).host;

  let response: Response;
  try {
    response = await fetchFn(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new GoogleApiError(`Google API ${method} ${host} failed (network error).`, 0);
  }

  if (!response.ok) {
    throw new GoogleApiError(
      `Google API ${method} ${host} failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  return response;
}
