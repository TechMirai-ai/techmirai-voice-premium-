/**
 * The developer archive for one finished call (VP-12, split in VP-13): a summary row in the private
 * Google Sheet that links to two Drive files — the full transcript (transcript folder) and the
 * audio (audio folder) — both named `<date>-<time>-<topic>`.
 *
 * Three retryable phases, in this order:
 *   1. SHEET — append the row (status, ids, duration). Cheap, so the call is on record first.
 *   2. TRANSCRIPT — upload the transcript as a .txt file, write its link into the row.
 *   3. AUDIO — download the recording, upload it, write its link into the row. Slow and the
 *      likeliest to fail, so it never gates the transcript.
 * The job remembers how far it got (`sheetRange`, `transcriptUrl`, `driveUrl`, `fileBaseName`), so a
 * retry resumes at the phase that failed: it never appends a second row, never uploads a file twice,
 * and always reuses the same file name.
 *
 * Pure orchestration over small interfaces — Postgres, Google and Vapi are injected, which is what
 * makes the retry behaviour testable. Nothing here logs; failure messages are `phase: message` and
 * never contain the transcript or a URL.
 */
import { formatDuration } from '../lib/callDuration.js';
import { archiveBaseName } from './archiveFileName.js';
import type { DriveClient } from './drive.js';
import { FIRST_SHEET_RANGE, type SheetsClient } from './sheets.js';

/** Sheet columns: A–F describe the call, G and H link to the Drive files, I is the call length. */
export const AUDIO_LINK_COLUMN = 'G';
export const TRANSCRIPT_LINK_COLUMN = 'H';
const NO_RECORDING_TEXT = '(no recording)';
const NO_TRANSCRIPT_TEXT = '(no transcript)';
const MAX_FAILURE_MESSAGE_CHARS = 300;

export interface ArchiveJob {
  id: string;
  clientId: string;
  callId: string;
  attempts: number;
  language?: string | undefined;
  /** The staff-facing status derived for this call, for the developer's reference. */
  status?: string | undefined;
  /** Set once the call row exists: where it is, e.g. 'Sheet1!A5:I5'. */
  sheetRange?: string | undefined;
  /** Set once the audio is in Drive (or '(no recording)'). */
  driveUrl?: string | undefined;
  /** Set once the transcript file is in Drive (or '(no transcript)'). */
  transcriptUrl?: string | undefined;
  /** The reserved `<date>-<time>-<topic>[-n]` name both files share; fixed once reserved. */
  fileBaseName?: string | undefined;
  /** From the call log, which is saved before archiving starts. */
  topic?: string | undefined;
  /** Call start for naming: the call log's started_at, else when it was logged. */
  startedAt?: Date | undefined;
  durationSeconds?: number | undefined;
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
  recordTranscriptLink(jobId: string, transcriptUrl: string): Promise<void>;
  /** Atomically claims a free name starting from `base`, adding -2, -3… on collision; returns it. */
  reserveFileBaseName(job: ArchiveJob, base: string): Promise<string>;
  markDone(jobId: string): Promise<void>;
  recordFailure(jobId: string, message: string): Promise<void>;
}

export type ArchiveSheets = Pick<SheetsClient, 'appendRow' | 'updateCell'>;
export type ArchiveDrive = Pick<DriveClient, 'uploadFile'>;

export interface ArchiveDeps {
  store: JobStore;
  sheets: ArchiveSheets;
  drive: ArchiveDrive;
  audioFolderId: string;
  transcriptFolderId: string;
  /** The clinic's IANA timezone (client.yaml), used for file names only. */
  timeZoneFor(clientId: string): string;
}

export type ArchivePhase = 'sheet' | 'transcript' | 'audio';
export type ArchiveResult =
  { status: 'done' } | { status: 'failed'; phase: ArchivePhase; message: string };

function buildRow(job: ArchiveJob, source: ArchiveSource): string[] {
  return [
    source.startedAt ?? '',
    job.clientId,
    job.callId,
    job.language ?? '',
    job.status ?? '',
    source.endedReason ?? '',
    '', // audio link — written back once the upload succeeds
    '', // transcript link — likewise
    job.durationSeconds === undefined ? '' : formatDuration(job.durationSeconds),
  ];
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
};

/** 'Sheet1!A5:I5' + 'G' → 'Sheet1!G5'; keeps a quoted sheet name ("'Call log'!…") exactly as Google wrote it. */
function linkCell(sheetRange: string, column: string): string {
  const bang = sheetRange.lastIndexOf('!');
  const prefix = bang >= 0 ? `${sheetRange.slice(0, bang)}!` : '';
  const row = /^[A-Z]+(\d+)/.exec(sheetRange.slice(bang + 1))?.[1];
  if (!row) throw new Error('could not locate the call row to write the file link into');
  return `${prefix}${column}${row}`;
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, MAX_FAILURE_MESSAGE_CHARS);
}

async function fail(
  deps: ArchiveDeps,
  job: ArchiveJob,
  phase: ArchivePhase,
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

/** Phase 2: the transcript file, then its link into the row. */
async function archiveTranscript(
  deps: ArchiveDeps,
  job: ArchiveJob,
  baseName: string,
  source: ArchiveSource,
  sheetRange: string,
): Promise<void> {
  let link = job.transcriptUrl;
  if (!link) {
    if (source.transcript.length === 0) {
      link = NO_TRANSCRIPT_TEXT;
    } else {
      const uploaded = await deps.drive.uploadFile({
        folderId: deps.transcriptFolderId,
        name: `${baseName}.txt`,
        mimeType: 'text/plain',
        bytes: new TextEncoder().encode(source.transcript),
      });
      link = uploaded.link;
    }
    await deps.store.recordTranscriptLink(job.id, link);
  }
  await deps.sheets.updateCell(linkCell(sheetRange, TRANSCRIPT_LINK_COLUMN), link);
}

/** Phase 3: the audio file, then its link into the row. */
async function archiveAudio(
  deps: ArchiveDeps,
  job: ArchiveJob,
  baseName: string,
  source: ArchiveSource,
  sheetRange: string,
): Promise<void> {
  let link = job.driveUrl;
  if (!link) {
    const audio = await source.fetchAudio();
    if (audio) {
      const uploaded = await deps.drive.uploadFile({
        folderId: deps.audioFolderId,
        name: `${baseName}.${EXTENSIONS[audio.mimeType] ?? 'bin'}`,
        mimeType: audio.mimeType,
        bytes: audio.bytes,
      });
      link = uploaded.link;
    } else {
      link = NO_RECORDING_TEXT;
    }
    await deps.store.recordDriveLink(job.id, link);
  }
  await deps.sheets.updateCell(linkCell(sheetRange, AUDIO_LINK_COLUMN), link);
}

export async function archiveJob(
  job: ArchiveJob,
  source: ArchiveSource,
  deps: ArchiveDeps,
): Promise<ArchiveResult> {
  let sheetRange = job.sheetRange;

  if (!sheetRange) {
    try {
      sheetRange = await deps.sheets.appendRow(FIRST_SHEET_RANGE, buildRow(job, source));
      await deps.store.recordSheetRow(job.id, sheetRange);
    } catch (error) {
      return fail(deps, job, 'sheet', error);
    }
  }

  // One name for both files, reserved once: a retry of either phase reuses it, never re-derives it.
  let baseName: string;
  try {
    baseName =
      job.fileBaseName ??
      (await deps.store.reserveFileBaseName(
        job,
        archiveBaseName(job.startedAt, job.topic, deps.timeZoneFor(job.clientId)),
      ));
  } catch (error) {
    return fail(deps, job, 'transcript', error);
  }

  try {
    await archiveTranscript(deps, job, baseName, source, sheetRange);
  } catch (error) {
    return fail(deps, job, 'transcript', error);
  }

  try {
    await archiveAudio(deps, job, baseName, source, sheetRange);
    await deps.store.markDone(job.id);
    return { status: 'done' };
  } catch (error) {
    return fail(deps, job, 'audio', error);
  }
}
