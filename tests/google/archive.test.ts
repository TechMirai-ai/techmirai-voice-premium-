import { describe, expect, test, vi } from 'vitest';

import {
  AUDIO_LINK_COLUMN,
  MAX_TRANSCRIPT_CELLS,
  TRANSCRIPT_CELL_CHARS,
  archiveJob,
  chunkTranscript,
  type ArchiveJob,
  type ArchiveSource,
} from '../../src/google/archive.js';
import { GoogleApiError } from '../../src/google/http.js';

function job(overrides: Partial<ArchiveJob> = {}): ArchiveJob {
  return {
    id: 'job-1',
    clientId: 'sakura-seikotsuin',
    callId: 'call-1',
    attempts: 1,
    language: 'ja',
    status: 'needs_callback',
    ...overrides,
  };
}

function source(overrides: Partial<ArchiveSource> = {}): ArchiveSource {
  return {
    transcript: 'AI: Hello\nUser: Hi',
    startedAt: '2026-10-12T01:00:00.000Z',
    endedReason: 'assistant-ended-call',
    fetchAudio: () => Promise.resolve({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' }),
    ...overrides,
  };
}

function fakes() {
  // Typed as the mocks themselves (assignable to JobStore) so `expect(store.x)` is not an unbound method.
  const store = {
    recordSheetRow: vi.fn((_jobId: string, _range: string) => Promise.resolve()),
    recordDriveLink: vi.fn(() => Promise.resolve()),
    markDone: vi.fn(() => Promise.resolve()),
    recordFailure: vi.fn(() => Promise.resolve()),
  };
  const sheets = {
    appendRow: vi.fn((_range: string, _values: readonly string[]) =>
      Promise.resolve('Sheet1!A5:J5'),
    ),
    clearRange: vi.fn(() => Promise.resolve()),
    updateCell: vi.fn(() => Promise.resolve()),
  };
  const drive = {
    createFolder: vi.fn(),
    getFile: vi.fn(),
    deleteFile: vi.fn(),
    uploadFile: vi.fn(() =>
      Promise.resolve({ id: 'file-1', link: 'https://drive.google.com/file/d/file-1/view' }),
    ),
  };
  return { store, sheets, drive, deps: { store, sheets, drive, folderId: 'folder-1' } };
}

describe('archiveJob — happy path', () => {
  test('appends the transcript row first, then uploads audio and writes the link into that row', async () => {
    const { deps, sheets, drive, store } = fakes();

    const result = await archiveJob(job(), source(), deps);

    expect(result).toEqual({ status: 'done' });
    const row = sheets.appendRow.mock.calls[0]![1] as string[];
    expect(row.slice(0, 6)).toEqual([
      '2026-10-12T01:00:00.000Z',
      'sakura-seikotsuin',
      'call-1',
      'ja',
      'needs_callback',
      'assistant-ended-call',
    ]);
    expect(row[6]).toBe(''); // audio link filled in later
    expect(row[7]).toBe('AI: Hello\nUser: Hi');
    expect(store.recordSheetRow).toHaveBeenCalledWith('job-1', 'Sheet1!A5:J5');
    expect(drive.uploadFile).toHaveBeenCalledWith({
      folderId: 'folder-1',
      name: '2026-10-12T01-00-00-000Z--sakura-seikotsuin--call-1.wav',
      mimeType: 'audio/wav',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(store.recordDriveLink).toHaveBeenCalledWith(
      'job-1',
      'https://drive.google.com/file/d/file-1/view',
    );
    expect(sheets.updateCell).toHaveBeenCalledWith(
      `Sheet1!${AUDIO_LINK_COLUMN}5`,
      'https://drive.google.com/file/d/file-1/view',
    );
    expect(store.markDone).toHaveBeenCalledWith('job-1');
  });

  test('the transcript is saved before the audio is even downloaded', async () => {
    const { deps, sheets } = fakes();
    const order: string[] = [];
    sheets.appendRow.mockImplementation(() => {
      order.push('sheet');
      return Promise.resolve('Sheet1!A5:J5');
    });

    await archiveJob(
      job(),
      source({
        fetchAudio: () => {
          order.push('audio');
          return Promise.resolve({ bytes: new Uint8Array(), mimeType: 'audio/wav' });
        },
      }),
      deps,
    );

    expect(order).toEqual(['sheet', 'audio']);
  });
});

describe('archiveJob — failures never lose the transcript or duplicate work', () => {
  test('an audio failure leaves the transcript row saved and records the failure', async () => {
    const { deps, store, sheets } = fakes();

    const result = await archiveJob(
      job(),
      source({ fetchAudio: () => Promise.reject(new GoogleApiError('Drive down', 503)) }),
      deps,
    );

    expect(result).toEqual({ status: 'failed', phase: 'audio', message: 'Drive down' });
    expect(sheets.appendRow).toHaveBeenCalledTimes(1);
    expect(store.recordSheetRow).toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith('job-1', 'audio: Drive down');
    expect(store.markDone).not.toHaveBeenCalled();
  });

  test('a retry after an audio failure uploads the audio but does NOT append a second transcript row', async () => {
    const { deps, sheets, drive } = fakes();

    await archiveJob(job({ sheetRange: 'Sheet1!A5:J5', attempts: 2 }), source(), deps);

    expect(sheets.appendRow).not.toHaveBeenCalled();
    expect(drive.uploadFile).toHaveBeenCalledTimes(1);
    expect(sheets.updateCell).toHaveBeenCalledWith(
      `Sheet1!${AUDIO_LINK_COLUMN}5`,
      expect.any(String),
    );
  });

  test('a Sheet failure stops before touching audio and records the failure', async () => {
    const { deps, sheets, drive, store } = fakes();
    sheets.appendRow.mockRejectedValue(new GoogleApiError('Sheets down', 500));
    const fetchAudio = vi.fn();

    const result = await archiveJob(job(), source({ fetchAudio }), deps);

    expect(result.status).toBe('failed');
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith('job-1', 'sheet: Sheets down');
  });

  test('if the link write-back fails after the upload, a retry does not upload the audio again', async () => {
    const { deps, sheets, drive } = fakes();

    await archiveJob(
      job({
        sheetRange: 'Sheet1!A5:J5',
        driveUrl: 'https://drive.google.com/file/d/file-1/view',
        attempts: 3,
      }),
      source(),
      deps,
    );

    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(sheets.updateCell).toHaveBeenCalledWith(
      `Sheet1!${AUDIO_LINK_COLUMN}5`,
      'https://drive.google.com/file/d/file-1/view',
    );
    expect(deps.store.markDone).toHaveBeenCalled();
  });

  test('keeps a quoted sheet-name prefix intact when writing the link back', async () => {
    const { deps, sheets } = fakes();
    sheets.appendRow.mockResolvedValue("'Call log'!A7:J7");

    await archiveJob(job(), source(), deps);

    expect(sheets.updateCell).toHaveBeenCalledWith(
      `'Call log'!${AUDIO_LINK_COLUMN}7`,
      expect.any(String),
    );
  });

  test('a failure message never contains the transcript', async () => {
    const { deps, store } = fakes();
    deps.sheets.appendRow.mockRejectedValue(new GoogleApiError('HTTP 500', 500));

    await archiveJob(job(), source({ transcript: 'SECRET PATIENT WORDS' }), deps);

    expect(
      JSON.stringify((store.recordFailure as ReturnType<typeof vi.fn>).mock.calls),
    ).not.toContain('SECRET');
  });
});

describe('archiveJob — calls without a recording', () => {
  test('completes: the link cell says so and nothing is uploaded', async () => {
    const { deps, drive, sheets, store } = fakes();

    const result = await archiveJob(
      job(),
      source({ fetchAudio: () => Promise.resolve(undefined) }),
      deps,
    );

    expect(result).toEqual({ status: 'done' });
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(sheets.updateCell).toHaveBeenCalledWith(
      `Sheet1!${AUDIO_LINK_COLUMN}5`,
      '(no recording)',
    );
    expect(store.markDone).toHaveBeenCalled();
  });
});

describe('chunkTranscript', () => {
  test('keeps a short transcript in one cell', () => {
    expect(chunkTranscript('hello')).toEqual(['hello']);
  });

  test('an empty transcript still yields one (empty) cell so the columns line up', () => {
    expect(chunkTranscript('')).toEqual(['']);
  });

  test('splits a long transcript so no cell exceeds the limit, losing nothing', () => {
    const text = 'x'.repeat(TRANSCRIPT_CELL_CHARS * 2 + 10);
    const chunks = chunkTranscript(text);
    expect(chunks).toHaveLength(3);
    expect(chunks.every((chunk) => chunk.length <= TRANSCRIPT_CELL_CHARS)).toBe(true);
    expect(chunks.join('')).toBe(text);
    expect(TRANSCRIPT_CELL_CHARS).toBeLessThan(50_000); // Google Sheets' per-cell limit
  });

  test('truncates absurdly long transcripts with an explicit marker instead of failing', () => {
    const text = 'y'.repeat(TRANSCRIPT_CELL_CHARS * (MAX_TRANSCRIPT_CELLS + 3));
    const chunks = chunkTranscript(text);
    expect(chunks).toHaveLength(MAX_TRANSCRIPT_CELLS);
    expect(chunks.at(-1)).toMatch(/truncated/i);
    expect(chunks.every((chunk) => chunk.length <= 50_000)).toBe(true);
  });
});
