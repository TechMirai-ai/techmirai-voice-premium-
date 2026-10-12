/**
 * The developer archive for one finished call (VP-12): full transcript in the private Google Sheet,
 * audio in the private Drive folder, the audio's permanent link written back next to the transcript.
 *
 * Two retryable phases, deliberately in this order:
 *   1. SHEET — append the transcript row. Cheap, so the transcript is safe first.
 *   2. AUDIO — download the recording, upload it to Drive, write the Drive link into the row from
 *      phase 1. Slow and the likelier one to fail, so it never gates the transcript.
 * The job remembers how far it got (`sheetRange`, `driveUrl`), so a retry resumes at the phase that
 * failed: it never appends a second transcript row and never uploads the same audio twice.
 *
 * Pure orchestration over small interfaces — Postgres, Google and Vapi are injected, which is what
 * makes the retry behaviour testable. Nothing here logs; failure messages are `phase: message` and
 * never contain the transcript or a URL.
 */
import type { DriveClient } from './drive.js';
import { FIRST_SHEET_RANGE, type SheetsClient } from './sheets.js';

/** Column G (the 7th) holds the audio link; the transcript follows from column H. */
export const AUDIO_LINK_COLUMN = 'G';
/** Google Sheets rejects cells over 50,000 characters. */
export const TRANSCRIPT_CELL_CHARS = 45_000;
export const MAX_TRANSCRIPT_CELLS = 8;
const NO_RECORDING_TEXT = '(no recording)';
const MAX_FAILURE_MESSAGE_CHARS = 300;

export interface ArchiveJob {
  id: string;
  clientId: string;
  callId: string;
  attempts: number;
  language?: string | undefined;
  /** The staff-facing status derived for this call, for the developer's reference. */
  status?: string | undefined;
  /** Set once the transcript row exists: where it is, e.g. 'Sheet1!A5:J5'. */
  sheetRange?: string | undefined;
  /** Set once the audio is in Drive. */
  driveUrl?: string | undefined;
}

export interface ArchiveAudio {
  bytes: Uint8Array;
  mimeType: string;
}

export interface ArchiveSource {
  transcript: string;
  startedAt?: string | undefined;
  endedReason?: string | undefined;
  /** `undefined` when the call has no recording. May throw; the failure is retried later. */
  fetchAudio(): Promise<ArchiveAudio | undefined>;
}

export interface JobStore {
  recordSheetRow(jobId: string, sheetRange: string): Promise<void>;
  recordDriveLink(jobId: string, driveUrl: string): Promise<void>;
  markDone(jobId: string): Promise<void>;
  recordFailure(jobId: string, message: string): Promise<void>;
}

export type ArchiveSheets = Pick<SheetsClient, 'appendRow' | 'updateCell'>;
export type ArchiveDrive = Pick<DriveClient, 'uploadFile'>;

export interface ArchiveDeps {
  store: JobStore;
  sheets: ArchiveSheets;
  drive: ArchiveDrive;
  folderId: string;
}

export type ArchiveResult =
  { status: 'done' } | { status: 'failed'; phase: 'sheet' | 'audio'; message: string };

/** Splits a transcript across cells below the Sheets limit; truncates (with a marker) past the cap. */
export function chunkTranscript(transcript: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < transcript.length; offset += TRANSCRIPT_CELL_CHARS) {
    chunks.push(transcript.slice(offset, offset + TRANSCRIPT_CELL_CHARS));
  }
  if (chunks.length === 0) return [''];
  if (chunks.length <= MAX_TRANSCRIPT_CELLS) return chunks;

  const kept = chunks.slice(0, MAX_TRANSCRIPT_CELLS);
  const droppedChars = transcript.length - MAX_TRANSCRIPT_CELLS * TRANSCRIPT_CELL_CHARS;
  const marker = `\n[truncated: ${droppedChars} more characters — full text via the Vapi call id]`;
  kept[MAX_TRANSCRIPT_CELLS - 1] =
    (kept[MAX_TRANSCRIPT_CELLS - 1] ?? '').slice(0, TRANSCRIPT_CELL_CHARS - marker.length) + marker;
  return kept;
}

function buildRow(job: ArchiveJob, source: ArchiveSource): string[] {
  return [
    source.startedAt ?? '',
    job.clientId,
    job.callId,
    job.language ?? '',
    job.status ?? '',
    source.endedReason ?? '',
    '', // audio link — written back once the upload succeeds
    ...chunkTranscript(source.transcript),
  ];
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};

function audioFileName(job: ArchiveJob, source: ArchiveSource, mimeType: string): string {
  const stamp = (source.startedAt ?? 'unknown-time').replace(/[:.]/g, '-');
  return `${stamp}--${job.clientId}--${job.callId}.${EXTENSIONS[mimeType] ?? 'bin'}`;
}

/** 'Sheet1!A5:J5' → 'Sheet1!G5'; keeps a quoted sheet name ("'Call log'!…") exactly as Google wrote it. */
function audioLinkCell(sheetRange: string): string {
  const bang = sheetRange.lastIndexOf('!');
  const prefix = bang >= 0 ? `${sheetRange.slice(0, bang)}!` : '';
  const row = /^[A-Z]+(\d+)/.exec(sheetRange.slice(bang + 1))?.[1];
  if (!row) throw new Error('could not locate the transcript row to write the audio link into');
  return `${prefix}${AUDIO_LINK_COLUMN}${row}`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

async function fail(
  deps: ArchiveDeps,
  job: ArchiveJob,
  phase: 'sheet' | 'audio',
  error: unknown,
): Promise<ArchiveResult> {
  const message = describe(error);
  try {
    await deps.store.recordFailure(job.id, `${phase}: ${message}`);
  } catch {
    // The original failure is what matters; a second failure to record it must not mask it.
  }
  return { status: 'failed', phase, message };
}

export async function archiveJob(
  job: ArchiveJob,
  source: ArchiveSource,
  deps: ArchiveDeps,
): Promise<ArchiveResult> {
  let sheetRange = job.sheetRange;

  // Phase 1 — the transcript row.
  if (!sheetRange) {
    try {
      sheetRange = await deps.sheets.appendRow(FIRST_SHEET_RANGE, buildRow(job, source));
      await deps.store.recordSheetRow(job.id, sheetRange);
    } catch (error) {
      return fail(deps, job, 'sheet', error);
    }
  }

  // Phase 2 — the audio, and the link back into the row from phase 1.
  try {
    const cell = audioLinkCell(sheetRange);
    let link = job.driveUrl;
    if (!link) {
      const audio = await source.fetchAudio();
      if (audio) {
        const uploaded = await deps.drive.uploadFile({
          folderId: deps.folderId,
          name: audioFileName(job, source, audio.mimeType),
          mimeType: audio.mimeType,
          bytes: audio.bytes,
        });
        link = uploaded.link;
        await deps.store.recordDriveLink(job.id, link);
      } else {
        link = NO_RECORDING_TEXT;
      }
    }
    await deps.sheets.updateCell(cell, link);
    await deps.store.markDone(job.id);
    return { status: 'done' };
  } catch (error) {
    return fail(deps, job, 'audio', error);
  }
}
