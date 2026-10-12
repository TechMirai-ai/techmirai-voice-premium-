/**
 * Minimal Google Sheets v4 client for the developer transcript archive (VP-12). Authenticated as
 * the service account, which has been given Editor on the one private Sheet and nothing else.
 */
import { z } from 'zod';

import type { AccessTokenProvider } from './auth.js';
import { GoogleApiError, googleFetch } from './http.js';

const SHEETS_URL = 'https://sheets.googleapis.com/v4/spreadsheets';

/** An A1 range with no tab name addresses the spreadsheet's first tab, so no tab needs creating. */
export const FIRST_SHEET_RANGE = 'A1';

export interface SheetsClient {
  /** Appends one row below the last row of `sheetName`; returns the A1 range it was written to. */
  appendRow(sheetName: string, values: readonly string[]): Promise<string>;
  clearRange(range: string): Promise<void>;
}

const appendSchema = z.object({ updates: z.object({ updatedRange: z.string().min(1) }) });

export function createSheetsClient(
  auth: AccessTokenProvider,
  spreadsheetId: string,
  fetchFn: typeof fetch = fetch,
): SheetsClient {
  const base = `${SHEETS_URL}/${encodeURIComponent(spreadsheetId)}/values`;
  const json = { 'content-type': 'application/json; charset=UTF-8' };

  return {
    async appendRow(sheetName, values) {
      const response = await googleFetch(
        fetchFn,
        auth,
        `${base}/${encodeURIComponent(sheetName)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
        { method: 'POST', headers: json, body: JSON.stringify({ values: [values] }) },
      );
      const parsed = appendSchema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) {
        throw new GoogleApiError(
          'Google Sheets response was not in the expected shape.',
          response.status,
        );
      }
      return parsed.data.updates.updatedRange;
    },

    async clearRange(range) {
      await googleFetch(fetchFn, auth, `${base}/${encodeURIComponent(range)}:clear`, {
        method: 'POST',
        headers: json,
        body: '{}',
      });
    },
  };
}
