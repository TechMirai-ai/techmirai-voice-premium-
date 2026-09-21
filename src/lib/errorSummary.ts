/**
 * A log-safe description of an error on a code path that handles personal data.
 *
 * Error MESSAGES are not safe there: a Postgres driver error can echo the row
 * it rejected, and a JSON parse error quotes a snippet of the body. A caller's
 * name inside such text cannot be found by src/lib/redact.ts (it only masks
 * names under known keys). So log the error's type and code, never its text.
 */
export interface ErrorSummary {
  errorName: string;
  errorCode?: string;
}

export function summarizeError(error: unknown): ErrorSummary {
  if (!(error instanceof Error)) return { errorName: typeof error };

  const code = (error as { code?: unknown }).code;
  return {
    errorName: error.name,
    ...(typeof code === 'string' ? { errorCode: code } : {}),
  };
}
