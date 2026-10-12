import { describe, expect, test, vi } from 'vitest';

import { GoogleApiError, createDriveClient } from '../../src/google/drive.js';
import { requestUrl } from '../../src/google/http.js';
import { createSheetsClient } from '../../src/google/sheets.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | Uint8Array | undefined;
}

/** Fake Google API: answers requests in order and records them. */
function fakeApi(
  responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Call[] = [];
  const queue = [...responses];
  const fetchFn = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: requestUrl(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body as string | Uint8Array | undefined,
    });
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    return Promise.resolve(
      new Response(next.json === undefined ? null : JSON.stringify(next.json), {
        status: next.status ?? 200,
        headers: next.headers ?? {},
      }),
    );
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

const auth = { getAccessToken: () => Promise.resolve('tok') };

describe('createDriveClient', () => {
  test('creates a folder with the folder mime type and returns its id', async () => {
    const { fetchFn, calls } = fakeApi([{ json: { id: 'folder-1' } }]);
    const drive = createDriveClient(auth, fetchFn);

    expect(await drive.createFolder('Call audio (private)')).toBe('folder-1');
    expect(calls[0]?.url).toBe('https://www.googleapis.com/drive/v3/files?fields=id');
    expect(calls[0]?.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      name: 'Call audio (private)',
      mimeType: 'application/vnd.google-apps.folder',
    });
  });

  test('uploads in two steps (resumable): metadata with the parent folder, then the bytes', async () => {
    const { fetchFn, calls } = fakeApi([
      { headers: { location: 'https://upload.example/session-1' } },
      { json: { id: 'file-1', webViewLink: 'https://drive.google.com/file/d/file-1/view' } },
    ]);
    const drive = createDriveClient(auth, fetchFn);
    const bytes = new Uint8Array([1, 2, 3]);

    const uploaded = await drive.uploadFile({
      folderId: 'folder-1',
      name: 'call-1.wav',
      mimeType: 'audio/wav',
      bytes,
    });

    expect(uploaded).toEqual({ id: 'file-1', link: 'https://drive.google.com/file/d/file-1/view' });
    expect(calls[0]?.url).toContain('uploadType=resumable');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      name: 'call-1.wav',
      parents: ['folder-1'],
    });
    expect(calls[0]?.headers['x-upload-content-type']).toBe('audio/wav');
    expect(calls[1]?.url).toBe('https://upload.example/session-1');
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.body).toEqual(bytes);
  });

  test('fails if Google does not return an upload session location', async () => {
    const { fetchFn } = fakeApi([{ json: {} }]);
    const drive = createDriveClient(auth, fetchFn);

    await expect(
      drive.uploadFile({
        folderId: 'f',
        name: 'a',
        mimeType: 'audio/wav',
        bytes: new Uint8Array(),
      }),
    ).rejects.toBeInstanceOf(GoogleApiError);
  });

  test('turns an API error into GoogleApiError carrying the HTTP status but not the body', async () => {
    const { fetchFn } = fakeApi([
      { status: 403, json: { error: { message: 'storage quota secret-detail' } } },
    ]);
    const drive = createDriveClient(auth, fetchFn);

    const failure = (await drive
      .createFolder('x')
      .catch((error: unknown) => error)) as GoogleApiError;

    expect(failure).toBeInstanceOf(GoogleApiError);
    expect(failure.status).toBe(403);
    expect(failure.message).not.toContain('secret-detail');
  });

  test('deletes a file by id', async () => {
    const { fetchFn, calls } = fakeApi([{ status: 204 }]);
    await createDriveClient(auth, fetchFn).deleteFile('file-1');
    expect(calls[0]?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe('https://www.googleapis.com/drive/v3/files/file-1');
  });

  test('reads a file’s metadata (used to prove an upload exists and is not trashed)', async () => {
    const { fetchFn, calls } = fakeApi([
      { json: { id: 'file-1', trashed: false, size: '3', webViewLink: 'https://x/view' } },
    ]);
    const meta = await createDriveClient(auth, fetchFn).getFile('file-1');
    expect(meta).toEqual({ id: 'file-1', trashed: false, sizeBytes: 3, link: 'https://x/view' });
    expect(calls[0]?.url).toContain('fields=id%2Ctrashed%2Csize%2CwebViewLink');
  });
});

describe('createSheetsClient', () => {
  test('appends one row as raw values and returns the range it landed in', async () => {
    const { fetchFn, calls } = fakeApi([{ json: { updates: { updatedRange: 'Calls!A5:C5' } } }]);
    const sheets = createSheetsClient(auth, 'sheet-1', fetchFn);

    const range = await sheets.appendRow('Calls', ['2026-10-12', 'call-1', 'hello']);

    expect(range).toBe('Calls!A5:C5');
    expect(calls[0]?.url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Calls:append' +
        '?valueInputOption=RAW&insertDataOption=INSERT_ROWS',
    );
    expect(calls[0]?.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      values: [['2026-10-12', 'call-1', 'hello']],
    });
  });

  test('clears a range', async () => {
    const { fetchFn, calls } = fakeApi([{ json: {} }]);
    await createSheetsClient(auth, 'sheet-1', fetchFn).clearRange('Calls!A5:C5');
    expect(calls[0]?.url).toBe(
      'https://sheets.googleapis.com/v4/spreadsheets/sheet-1/values/Calls!A5%3AC5:clear',
    );
  });

  test('sheet names with spaces are URL-encoded', async () => {
    const { fetchFn, calls } = fakeApi([{ json: { updates: { updatedRange: "'Call log'!A1" } } }]);
    await createSheetsClient(auth, 'sheet-1', fetchFn).appendRow('Call log', ['x']);
    expect(calls[0]?.url).toContain('/values/Call%20log:append');
  });

  test('an API error becomes GoogleApiError', async () => {
    const { fetchFn } = fakeApi([{ status: 404, json: {} }]);
    await expect(
      createSheetsClient(auth, 'missing', fetchFn).appendRow('Calls', ['x']),
    ).rejects.toMatchObject({ name: 'GoogleApiError', status: 404 });
  });
});
