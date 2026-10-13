import { describe, expect, test, vi } from 'vitest';

import {
  AUDIO_LINK_COLUMN,
  TRANSCRIPT_LINK_COLUMN,
  archiveJob,
  type ArchiveJob,
  type ArchiveSource,
} from '../../src/google/archive.js';
import { GoogleApiError } from '../../src/google/http.js';

const AUDIO_FOLDER = 'audio-folder';
const TRANSCRIPT_FOLDER = 'transcript-folder';
// The job starts 01:00:30 UTC, which is 10:00 in the clinic's timezone (Asia/Tokyo).
const BASE_NAME = '2026-10-12-1000-reservation';
const RANGE = 'Sheet1!A5:I5';
const LINK = 'https://drive.google.com/file/d/file-1/view';

function job(overrides: Partial<ArchiveJob> = {}): ArchiveJob {
  return {
    id: 'job-1',
    clientId: 'sakura-seikotsuin',
    callId: 'call-1',
    attempts: 1,
    language: 'ja',
    status: 'needs_callback',
    topic: 'reservation',
    startedAt: new Date('2026-10-12T01:00:30.000Z'),
    durationSeconds: 187,
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
    recordDriveLink: vi.fn((_jobId: string, _link: string) => Promise.resolve()),
    recordTranscriptLink: vi.fn((_jobId: string, _link: string) => Promise.resolve()),
    reserveFileBaseName: vi.fn((_job: ArchiveJob, base: string) => Promise.resolve(base)),
    markDone: vi.fn(() => Promise.resolve()),
    recordFailure: vi.fn(() => Promise.resolve()),
  };
  const sheets = {
    appendRow: vi.fn((_range: string, _values: readonly string[]) => Promise.resolve(RANGE)),
    clearRange: vi.fn(() => Promise.resolve()),
    updateCell: vi.fn((_range: string, _value: string) => Promise.resolve()),
  };
  const drive = {
    createFolder: vi.fn(),
    getFile: vi.fn(),
    deleteFile: vi.fn(),
    uploadFile: vi.fn((_request: { folderId: string; name: string }) =>
      Promise.resolve({ id: 'file-1', link: LINK }),
    ),
  };
  return {
    store,
    sheets,
    drive,
    deps: {
      store,
      sheets,
      drive,
      audioFolderId: AUDIO_FOLDER,
      transcriptFolderId: TRANSCRIPT_FOLDER,
      timeZoneFor: () => 'Asia/Tokyo',
    },
  };
}

describe('archiveJob — happy path', () => {
  test('the row holds links and the duration, never the transcript text', async () => {
    const { deps, sheets } = fakes();

    const result = await archiveJob(job(), source(), deps);

    expect(result).toEqual({ status: 'done' });
    const row = sheets.appendRow.mock.calls[0]![1] as string[];
    expect(row).toEqual([
      '2026-10-12T01:00:00.000Z',
      'sakura-seikotsuin',
      'call-1',
      'ja',
      'needs_callback',
      'assistant-ended-call',
      '', // audio link filled in later
      '', // transcript link filled in later
      '3:07',
    ]);
    expect(JSON.stringify(sheets.appendRow.mock.calls)).not.toContain('Hello');
  });

  test('uploads the transcript to its own folder and the audio to the audio folder, same base name', async () => {
    const { deps, drive, store, sheets } = fakes();

    await archiveJob(job(), source(), deps);

    expect(drive.uploadFile).toHaveBeenCalledTimes(2);
    expect(drive.uploadFile).toHaveBeenNthCalledWith(1, {
      folderId: TRANSCRIPT_FOLDER,
      name: `${BASE_NAME}.txt`,
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('AI: Hello\nUser: Hi'),
    });
    expect(drive.uploadFile).toHaveBeenNthCalledWith(2, {
      folderId: AUDIO_FOLDER,
      name: `${BASE_NAME}.wav`,
      mimeType: 'audio/wav',
      bytes: new Uint8Array([1, 2, 3]),
    });
    expect(store.reserveFileBaseName).toHaveBeenCalledTimes(1);
    expect(store.reserveFileBaseName).toHaveBeenCalledWith(expect.anything(), BASE_NAME);
    expect(sheets.updateCell).toHaveBeenCalledWith(`Sheet1!${TRANSCRIPT_LINK_COLUMN}5`, LINK);
    expect(sheets.updateCell).toHaveBeenCalledWith(`Sheet1!${AUDIO_LINK_COLUMN}5`, LINK);
    expect(store.markDone).toHaveBeenCalledWith('job-1');
  });

  test('an mp3 recording gets the same base name with an .mp3 extension', async () => {
    const { deps, drive } = fakes();

    await archiveJob(
      job(),
      source({
        fetchAudio: () => Promise.resolve({ bytes: new Uint8Array([9]), mimeType: 'audio/mpeg' }),
      }),
      deps,
    );

    const names = drive.uploadFile.mock.calls.map(([request]) => request.name);
    expect(names).toEqual([`${BASE_NAME}.txt`, `${BASE_NAME}.mp3`]);
  });

  test('uses the name the store hands back when the base name collides', async () => {
    const { deps, drive, store } = fakes();
    store.reserveFileBaseName.mockResolvedValue(`${BASE_NAME}-2`);

    await archiveJob(job(), source(), deps);

    const names = drive.uploadFile.mock.calls.map(([request]) => request.name);
    expect(names).toEqual([`${BASE_NAME}-2.txt`, `${BASE_NAME}-2.wav`]);
  });

  test('a call with no known duration leaves the duration cell empty', async () => {
    const { deps, sheets } = fakes();

    await archiveJob(job({ durationSeconds: undefined }), source(), deps);

    expect((sheets.appendRow.mock.calls[0]![1] as string[])[8]).toBe('');
  });

  test('the row is written before the transcript, and the transcript before the audio download', async () => {
    const { deps, sheets, drive } = fakes();
    const order: string[] = [];
    sheets.appendRow.mockImplementation(() => {
      order.push('sheet');
      return Promise.resolve(RANGE);
    });
    drive.uploadFile.mockImplementation((request) => {
      order.push(`upload:${request.folderId}`);
      return Promise.resolve({ id: 'file-1', link: LINK });
    });

    await archiveJob(
      job(),
      source({
        fetchAudio: () => {
          order.push('download');
          return Promise.resolve({ bytes: new Uint8Array(), mimeType: 'audio/wav' });
        },
      }),
      deps,
    );

    expect(order).toEqual([
      'sheet',
      `upload:${TRANSCRIPT_FOLDER}`,
      'download',
      `upload:${AUDIO_FOLDER}`,
    ]);
  });
});

describe('archiveJob — failures never lose data or duplicate work', () => {
  test('an audio failure leaves the row and the transcript saved and records the failure', async () => {
    const { deps, store, sheets, drive } = fakes();

    const result = await archiveJob(
      job(),
      source({ fetchAudio: () => Promise.reject(new GoogleApiError('Drive down', 503)) }),
      deps,
    );

    expect(result).toEqual({ status: 'failed', phase: 'audio', message: 'Drive down' });
    expect(sheets.appendRow).toHaveBeenCalledTimes(1);
    expect(drive.uploadFile).toHaveBeenCalledTimes(1); // the transcript
    expect(store.recordTranscriptLink).toHaveBeenCalledWith('job-1', LINK);
    expect(store.recordFailure).toHaveBeenCalledWith('job-1', 'audio: Drive down');
    expect(store.markDone).not.toHaveBeenCalled();
  });

  test('a transcript upload failure stops before the audio and records the phase', async () => {
    const { deps, drive, store } = fakes();
    drive.uploadFile.mockRejectedValue(new GoogleApiError('quota', 403));
    const fetchAudio = vi.fn();

    const result = await archiveJob(job(), source({ fetchAudio }), deps);

    expect(result).toEqual({ status: 'failed', phase: 'transcript', message: 'quota' });
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith('job-1', 'transcript: quota');
  });

  test('a retry after an audio failure uploads only the audio, under the same reserved name', async () => {
    const { deps, sheets, drive, store } = fakes();

    await archiveJob(
      job({
        sheetRange: RANGE,
        transcriptUrl: LINK,
        fileBaseName: BASE_NAME,
        attempts: 2,
      }),
      source(),
      deps,
    );

    expect(sheets.appendRow).not.toHaveBeenCalled();
    expect(store.reserveFileBaseName).not.toHaveBeenCalled();
    expect(drive.uploadFile).toHaveBeenCalledTimes(1);
    expect(drive.uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({ folderId: AUDIO_FOLDER, name: `${BASE_NAME}.wav` }),
    );
  });

  test('a Sheet failure stops before Drive and records the failure', async () => {
    const { deps, sheets, drive, store } = fakes();
    sheets.appendRow.mockRejectedValue(new GoogleApiError('Sheets down', 500));
    const fetchAudio = vi.fn();

    const result = await archiveJob(job(), source({ fetchAudio }), deps);

    expect(result.status).toBe('failed');
    expect(fetchAudio).not.toHaveBeenCalled();
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(store.recordFailure).toHaveBeenCalledWith('job-1', 'sheet: Sheets down');
  });

  test('if a link write-back fails after the uploads, a retry uploads nothing again', async () => {
    const { deps, sheets, drive } = fakes();

    await archiveJob(
      job({
        sheetRange: RANGE,
        transcriptUrl: LINK,
        driveUrl: LINK,
        fileBaseName: BASE_NAME,
        attempts: 3,
      }),
      source(),
      deps,
    );

    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(sheets.updateCell).toHaveBeenCalledWith(`Sheet1!${TRANSCRIPT_LINK_COLUMN}5`, LINK);
    expect(sheets.updateCell).toHaveBeenCalledWith(`Sheet1!${AUDIO_LINK_COLUMN}5`, LINK);
    expect(deps.store.markDone).toHaveBeenCalled();
  });

  test('keeps a quoted sheet-name prefix intact when writing the links back', async () => {
    const { deps, sheets } = fakes();
    sheets.appendRow.mockResolvedValue("'Call log'!A7:I7");

    await archiveJob(job(), source(), deps);

    expect(sheets.updateCell).toHaveBeenCalledWith(
      `'Call log'!${TRANSCRIPT_LINK_COLUMN}7`,
      expect.any(String),
    );
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

describe('archiveJob — calls without a recording or transcript', () => {
  test('no recording: completes, the audio cell says so and no audio is uploaded', async () => {
    const { deps, drive, sheets, store } = fakes();

    const result = await archiveJob(
      job(),
      source({ fetchAudio: () => Promise.resolve(undefined) }),
      deps,
    );

    expect(result).toEqual({ status: 'done' });
    expect(drive.uploadFile).toHaveBeenCalledTimes(1); // the transcript only
    expect(sheets.updateCell).toHaveBeenCalledWith(
      `Sheet1!${AUDIO_LINK_COLUMN}5`,
      '(no recording)',
    );
    expect(store.markDone).toHaveBeenCalled();
  });

  test('empty transcript: no empty file is uploaded, the cell says so', async () => {
    const { deps, drive, sheets } = fakes();

    const result = await archiveJob(job(), source({ transcript: '' }), deps);

    expect(result).toEqual({ status: 'done' });
    expect(drive.uploadFile).toHaveBeenCalledTimes(1); // the audio only
    expect(sheets.updateCell).toHaveBeenCalledWith(
      `Sheet1!${TRANSCRIPT_LINK_COLUMN}5`,
      '(no transcript)',
    );
  });
});
