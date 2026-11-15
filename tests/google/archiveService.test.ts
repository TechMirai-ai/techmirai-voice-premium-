import { describe, expect, test, vi } from 'vitest';

import type { ArchiveJob } from '../../src/google/archive.js';
import { loadClient } from '../../src/config/loadClient.js';
import {
  destinationNotConfigured,
  resolveArchiveDestination,
  type ArchiveDestination,
  type DestinationResult,
} from '../../src/google/archiveDestination.js';
import { ArchiveService, type ArchiveReportInput } from '../../src/google/archiveService.js';
import { requestUrl } from '../../src/google/http.js';
import type {
  ArchiveJobRepository,
  ArchiveQueueCounts,
} from '../../src/repositories/archiveJobRepository.js';

interface StoredJob extends ArchiveJob {
  state: 'pending' | 'done' | 'failed';
  leased: boolean;
  lastError?: string;
}

/** In-memory job queue with the same claim/lease semantics as the Postgres one. */
class MemoryJobs implements ArchiveJobRepository {
  readonly jobs = new Map<string, StoredJob>();

  enqueue(clientId: string, callId: string): Promise<void> {
    const key = `${clientId}/${callId}`;
    if (!this.jobs.has(key)) {
      this.jobs.set(key, {
        id: key,
        clientId,
        callId,
        attempts: 0,
        state: 'pending',
        leased: false,
        language: 'ja',
        status: 'unresolved',
      });
    }
    return Promise.resolve();
  }

  private claim(job: StoredJob): ArchiveJob {
    job.attempts += 1;
    job.leased = true;
    return { ...job };
  }

  claimCall(clientId: string, callId: string): Promise<ArchiveJob | undefined> {
    const job = this.jobs.get(`${clientId}/${callId}`);
    return Promise.resolve(
      job && job.state === 'pending' && !job.leased ? this.claim(job) : undefined,
    );
  }

  claimRunnable(limit: number): Promise<ArchiveJob[]> {
    const runnable = [...this.jobs.values()].filter((j) => j.state === 'pending' && !j.leased);
    return Promise.resolve(runnable.slice(0, limit).map((j) => this.claim(j)));
  }

  /** Test helper: the lease expires. */
  expireLeases(): void {
    for (const job of this.jobs.values()) job.leased = false;
  }

  private get(id: string): StoredJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`no job ${id}`);
    return job;
  }

  recordSheetRow(id: string, range: string): Promise<void> {
    this.get(id).sheetRange = range;
    return Promise.resolve();
  }
  recordDriveLink(id: string, url: string): Promise<void> {
    this.get(id).driveUrl = url;
    return Promise.resolve();
  }
  recordTranscriptLink(id: string, url: string): Promise<void> {
    this.get(id).transcriptUrl = url;
    return Promise.resolve();
  }
  reserveFileBaseName(job: ArchiveJob, base: string): Promise<string> {
    this.get(job.id).fileBaseName = base;
    return Promise.resolve(base);
  }
  markDone(id: string): Promise<void> {
    this.get(id).state = 'done';
    return Promise.resolve();
  }
  recordFailure(id: string, message: string): Promise<void> {
    this.get(id).lastError = message;
    return Promise.resolve();
  }
  /** Mirrors the Postgres one: records the reason, never changes the state. */
  recordBlocked(id: string, message: string): Promise<void> {
    this.get(id).lastError = message;
    return Promise.resolve();
  }
  countByState(): Promise<ArchiveQueueCounts> {
    const counts = { pending: 0, done: 0, failed: 0 };
    for (const job of this.jobs.values()) counts[job.state] += 1;
    return Promise.resolve(counts);
  }
}

const REPORT: ArchiveReportInput = {
  clientId: 'c',
  callId: 'call-1',
  transcript: 'AI: hi',
  startedAt: '2026-10-12T01:00:00.000Z',
  endedReason: 'assistant-ended-call',
};

const DEFAULT_DESTINATION: ArchiveDestination = {
  sheetId: 'sheet-1',
  audioFolderId: 'audio-folder',
  transcriptFolderId: 'transcript-folder',
};

function setup(
  options: {
    vapiRoutes?: Record<string, () => Response>;
    budgetMs?: number;
    /** clientId → destination; a client missing from the map is "not configured". Default: every client → DEFAULT_DESTINATION. */
    destinations?: Record<string, ArchiveDestination>;
  } = {},
) {
  const jobs = new MemoryJobs();
  const sheetsById = new Map<string, ReturnType<typeof makeSheets>>();
  const defaultSheets = makeSheets();
  const sheetsFor = vi.fn((sheetId: string) => {
    const existing = sheetsById.get(sheetId);
    if (existing) return existing;
    const created = sheetId === DEFAULT_DESTINATION.sheetId ? defaultSheets : makeSheets();
    sheetsById.set(sheetId, created);
    return created;
  });
  const destinationFor = vi.fn((clientId: string): DestinationResult => {
    const destination = options.destinations ? options.destinations[clientId] : DEFAULT_DESTINATION;
    return destination
      ? { ok: true, destination }
      : { ok: false, message: destinationNotConfigured(clientId, 'unset: TEST_ENV') };
  });
  // The default Sheet's mock is created up front for the older tests, but is only RECORDED in
  // `sheetsById` (what "touched" means) once the service actually asks for it.
  const sheets = defaultSheets;
  const drive = {
    uploadFile: vi.fn((_request: { folderId: string; name: string; bytes: Uint8Array }) =>
      Promise.resolve({ id: 'f', link: 'https://drive.example/f' }),
    ),
  };
  const routes = options.vapiRoutes ?? {};
  const vapiFetch = vi.fn((input: string | URL | Request) => {
    const route = routes[requestUrl(input)];
    return Promise.resolve(route ? route() : new Response('', { status: 404 }));
  }) as unknown as typeof fetch;
  const service = new ArchiveService({
    jobs,
    sheetsFor,
    drive,
    destinationFor,
    timeZoneFor: () => 'Asia/Tokyo',
    vapi: { apiKey: 'vapi-key', fetch: vapiFetch },
    ...(options.budgetMs !== undefined ? { inlineBudgetMs: options.budgetMs } : {}),
  });
  return { service, jobs, sheets, sheetsById, sheetsFor, drive, vapiFetch };
}

function makeSheets() {
  return {
    appendRow: vi.fn((_range: string, _values: readonly string[]) =>
      Promise.resolve('Sheet1!A5:J5'),
    ),
    updateCell: vi.fn((_range: string, _value: string) => Promise.resolve()),
  };
}

const WAV = () =>
  new Response(new Uint8Array([1, 2]), { headers: { 'content-type': 'audio/wav' } });
const MONO = 'https://api.vapi.ai/call/call-1/mono-recording';

describe('ArchiveService.archiveReport (inline, after the call)', () => {
  test('enqueues, archives and reports done', async () => {
    const { service, jobs, sheets, drive } = setup({ vapiRoutes: { [MONO]: WAV } });

    expect(await service.archiveReport(REPORT)).toBe('done');

    expect(sheets.appendRow).toHaveBeenCalledTimes(1);
    expect(drive.uploadFile).toHaveBeenCalledTimes(2); // the transcript file, then the audio
    expect(jobs.jobs.get('c/call-1')?.state).toBe('done');
  });

  test('uses the transcript from the report itself — no Vapi lookup needed — and puts it in a Drive file, not the Sheet', async () => {
    const { service, sheets, drive } = setup({ vapiRoutes: { [MONO]: WAV } });

    await service.archiveReport(REPORT);

    const request = drive.uploadFile.mock.calls[0]![0];
    expect(request).toMatchObject({ folderId: 'transcript-folder' });
    expect(request.name).toMatch(/\.txt$/);
    expect(new TextDecoder().decode(request.bytes)).toBe('AI: hi');
    expect(JSON.stringify(sheets.appendRow.mock.calls)).not.toContain('AI: hi');
  });

  test('a Google failure is reported as failed, never thrown, and the job stays pending for a retry', async () => {
    const { service, jobs, sheets } = setup({ vapiRoutes: { [MONO]: WAV } });
    sheets.appendRow.mockRejectedValue(new Error('Sheets down'));

    expect(await service.archiveReport(REPORT)).toBe('failed');

    const job = jobs.jobs.get('c/call-1')!;
    expect(job.state).toBe('pending');
    expect(job.lastError).toBe('sheet: Sheets down');
  });

  test('a slow audio step does not hold the response past the budget: "deferred", transcript already saved', async () => {
    const slow = () => new Promise<Response>(() => undefined); // never resolves
    const vapiRoutes = { [MONO]: slow as unknown as () => Response };
    const { service, sheets, jobs } = setup({ vapiRoutes, budgetMs: 20 });
    // make the fetch itself hang by returning a never-resolving promise
    const started = Date.now();

    const outcome = await service.archiveReport(REPORT);

    expect(outcome).toBe('deferred');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(sheets.appendRow).toHaveBeenCalledTimes(1);
    expect(jobs.jobs.get('c/call-1')?.sheetRange).toBe('Sheet1!A5:J5');
    expect(jobs.jobs.get('c/call-1')?.state).toBe('pending');
  });

  test('a redelivered report for a call already being archived is skipped, not duplicated', async () => {
    const { service, sheets } = setup({ vapiRoutes: { [MONO]: WAV } });
    await service.archiveReport(REPORT);

    expect(await service.archiveReport(REPORT)).toBe('skipped');
    expect(sheets.appendRow).toHaveBeenCalledTimes(1);
  });
});

describe('ArchiveService.retryPending', () => {
  const callJson = () =>
    Response.json({
      startedAt: '2026-10-12T01:00:00.000Z',
      endedReason: 'assistant-ended-call',
      artifact: { transcript: 'AI: recovered' },
    });

  test('re-fetches the call from Vapi and finishes jobs that never got archived', async () => {
    const { service, jobs, drive } = setup({
      vapiRoutes: { 'https://api.vapi.ai/call/call-1': callJson, [MONO]: WAV },
    });
    await jobs.enqueue('c', 'call-1');

    const summary = await service.retryPending();

    expect(summary).toMatchObject({ claimed: 1, done: 1, failed: 0 });
    expect(new TextDecoder().decode(drive.uploadFile.mock.calls[0]![0].bytes)).toBe(
      'AI: recovered',
    );
    expect(summary.queue).toEqual({ pending: 0, done: 1, failed: 0 });
  });

  test('resumes a half-finished job: the row is NOT appended a second time, both files are still uploaded', async () => {
    const { service, jobs, sheets, drive } = setup({
      vapiRoutes: { 'https://api.vapi.ai/call/call-1': callJson, [MONO]: WAV },
    });
    await jobs.enqueue('c', 'call-1');
    const stored = jobs.jobs.get('c/call-1')!;
    stored.sheetRange = 'Sheet1!A5:J5';
    stored.attempts = 1;

    await service.retryPending();

    expect(sheets.appendRow).not.toHaveBeenCalled();
    expect(drive.uploadFile).toHaveBeenCalledTimes(2);
    expect(sheets.updateCell).toHaveBeenCalledWith('Sheet1!H5', 'https://drive.example/f');
    expect(sheets.updateCell).toHaveBeenCalledWith('Sheet1!G5', 'https://drive.example/f');
  });

  test('a Vapi lookup failure is recorded against the job and counted, not thrown', async () => {
    const { service, jobs } = setup({
      vapiRoutes: { 'https://api.vapi.ai/call/call-1': () => new Response('', { status: 500 }) },
    });
    await jobs.enqueue('c', 'call-1');

    const summary = await service.retryPending();

    expect(summary).toMatchObject({ claimed: 1, done: 0, failed: 1 });
    expect(jobs.jobs.get('c/call-1')?.lastError).toMatch(/^fetch: .*500/);
  });

  test('does nothing when the queue is empty', async () => {
    const { service } = setup();
    expect(await service.retryPending()).toEqual({
      claimed: 0,
      done: 0,
      failed: 0,
      queue: { pending: 0, done: 0, failed: 0 },
    });
  });

  test('stops starting new work once the time budget is spent', async () => {
    const { service, jobs } = setup();
    await jobs.enqueue('c', 'call-1');

    const summary = await service.retryPending({ budgetMs: 0 });

    expect(summary.claimed).toBe(0);
    expect(summary.queue.pending).toBe(1);
  });

  test('a lease that has lapsed lets a stuck job be picked up again', async () => {
    const { service, jobs } = setup({
      vapiRoutes: { 'https://api.vapi.ai/call/call-1': callJson, [MONO]: WAV },
    });
    await jobs.enqueue('c', 'call-1');
    await jobs.claimCall('c', 'call-1'); // an inline attempt that never finished
    expect((await service.retryPending()).claimed).toBe(0); // still leased

    jobs.expireLeases();

    expect((await service.retryPending()).done).toBe(1);
  });
});

describe('per-client archive destinations', () => {
  const callJson = () =>
    Response.json({
      startedAt: '2026-10-12T01:00:00.000Z',
      endedReason: 'assistant-ended-call',
      artifact: { transcript: 'AI: hello' },
    });
  const routesFor = (...callIds: string[]) => ({
    ...Object.fromEntries(callIds.map((id) => [`https://api.vapi.ai/call/${id}`, callJson])),
    ...Object.fromEntries(
      callIds.map((id) => [`https://api.vapi.ai/call/${id}/mono-recording`, WAV]),
    ),
  });
  const A: ArchiveDestination = {
    sheetId: 'sheet-a',
    audioFolderId: 'audio-a',
    transcriptFolderId: 'transcripts-a',
  };
  const B: ArchiveDestination = {
    sheetId: 'sheet-b',
    audioFolderId: 'audio-b',
    transcriptFolderId: 'transcripts-b',
  };

  test('a job for client A writes only to A’s Sheet and folders, and B’s only to B’s', async () => {
    const { service, jobs, sheetsById, drive } = setup({
      destinations: { a: A, b: B },
      vapiRoutes: routesFor('call-a', 'call-b'),
    });
    await jobs.enqueue('a', 'call-a');
    await jobs.enqueue('b', 'call-b');

    const summary = await service.retryPending();

    expect(summary).toMatchObject({ claimed: 2, done: 2, failed: 0 });
    // Exactly two Sheets were ever touched, one row each, carrying the right client id (column B).
    expect([...sheetsById.keys()].sort()).toEqual(['sheet-a', 'sheet-b']);
    for (const [sheetId, clientId] of [['sheet-a', 'a'], ['sheet-b', 'b']] as const) {
      const sheet = sheetsById.get(sheetId)!;
      expect(sheet.appendRow).toHaveBeenCalledTimes(1);
      expect(sheet.appendRow.mock.calls[0]![1][1]).toBe(clientId);
    }
    // Every upload for a client's files landed in that client's folders, and nowhere else.
    const uploads = drive.uploadFile.mock.calls.map(([request]) => request);
    expect(uploads).toHaveLength(4); // transcript + audio, twice
    for (const upload of uploads) {
      const own = upload.name.startsWith('a-') ? A : B;
      expect([own.audioFolderId, own.transcriptFolderId]).toContain(upload.folderId);
    }
    expect(uploads.filter((u) => u.name.startsWith('a-')).map((u) => u.folderId).sort()).toEqual([
      'audio-a',
      'transcripts-a',
    ]);
    expect(uploads.filter((u) => u.name.startsWith('b-')).map((u) => u.folderId).sort()).toEqual([
      'audio-b',
      'transcripts-b',
    ]);
  });

  test('new Drive file names (transcript and audio) carry the client id', async () => {
    const { service, jobs, drive } = setup({
      destinations: { a: A },
      vapiRoutes: routesFor('call-a'),
    });
    await jobs.enqueue('a', 'call-a');
    jobs.jobs.get('a/call-a')!.startedAt = new Date('2026-10-12T01:00:00.000Z'); // the repo joins this from call_logs

    await service.retryPending();

    const names = drive.uploadFile.mock.calls.map(([request]) => request.name).sort();
    expect(names).toHaveLength(2);
    for (const name of names) expect(name).toMatch(/^a-2026-10-12-1000-no-topic\.(txt|wav|bin)$/);
  });

  test('a job whose file name was already reserved keeps it (existing files are never renamed)', async () => {
    const { service, jobs, drive } = setup({
      destinations: { a: A },
      vapiRoutes: routesFor('call-a'),
    });
    await jobs.enqueue('a', 'call-a');
    const stored = jobs.jobs.get('a/call-a')!;
    stored.fileBaseName = '2026-10-12-1000-reservation'; // reserved before this change: no prefix

    await service.retryPending();

    for (const [request] of drive.uploadFile.mock.calls) {
      expect(request.name).toMatch(/^2026-10-12-1000-reservation\./);
    }
  });

  describe('fails closed when the destination is not configured', () => {
    test('inline: zero Google or Vapi calls, a distinct recorded failure, the job kept pending', async () => {
      const { service, jobs, sheetsFor, drive, vapiFetch } = setup({ destinations: {} });

      const outcome = await service.archiveReport({ ...REPORT, clientId: 'x' });

      expect(outcome).toBe('failed');
      expect(sheetsFor).not.toHaveBeenCalled();
      expect(drive.uploadFile).not.toHaveBeenCalled();
      expect(vapiFetch).not.toHaveBeenCalled();
      const job = jobs.jobs.get('x/call-1')!;
      expect(job.state).toBe('pending');
      expect(job.lastError).toMatch(/^archive destination not configured for x\b/);
    });

    test('retry: the same, and it never falls back to another client’s destination', async () => {
      const { service, jobs, sheetsById, drive } = setup({
        destinations: { a: A },
        vapiRoutes: routesFor('call-x'),
      });
      await jobs.enqueue('x', 'call-x');

      const summary = await service.retryPending();

      expect(summary).toMatchObject({ claimed: 1, done: 0, failed: 1 });
      expect(sheetsById.size).toBe(0);
      expect(drive.uploadFile).not.toHaveBeenCalled();
      expect(jobs.jobs.get('x/call-x')!.lastError).toContain(
        'archive destination not configured for x',
      );
    });

    test('an unconfigured client does not block a configured one in the same queue', async () => {
      const { service, jobs, sheetsById } = setup({
        destinations: { a: A },
        vapiRoutes: routesFor('call-a', 'call-x'),
      });
      await jobs.enqueue('x', 'call-x'); // oldest, unconfigured
      await jobs.enqueue('a', 'call-a');

      const summary = await service.retryPending();

      expect(summary).toMatchObject({ claimed: 2, done: 1, failed: 1 });
      expect(sheetsById.get('sheet-a')!.appendRow).toHaveBeenCalledTimes(1);
      expect(jobs.jobs.get('a/call-a')!.state).toBe('done');
      expect(jobs.jobs.get('x/call-x')!.state).toBe('pending');
    });

    test('stays retryable: many blocked passes never make the job terminally failed, and it archives once config exists', async () => {
      const destinations: Record<string, ArchiveDestination> = {};
      const { service, jobs, sheetsById } = setup({
        destinations,
        vapiRoutes: routesFor('call-x'),
      });
      await jobs.enqueue('x', 'call-x');

      for (let pass = 0; pass < 8; pass += 1) {
        await service.retryPending(); // more passes than MAX_ARCHIVE_ATTEMPTS
        jobs.expireLeases();
      }
      expect(jobs.jobs.get('x/call-x')!.state).toBe('pending');
      expect(sheetsById.size).toBe(0);

      destinations['x'] = B; // Jamal sets the env vars
      const summary = await service.retryPending();

      expect(summary).toMatchObject({ done: 1, failed: 0 });
      expect(jobs.jobs.get('x/call-x')!.state).toBe('done');
      expect(sheetsById.get('sheet-b')!.appendRow).toHaveBeenCalledTimes(1);
    });
  });

  test('Sakura, with its existing variable names and ids unchanged, writes the same row to the same Sheet and folders as before', async () => {
    const env = {
      GOOGLE_ARCHIVE_SHEET_ID: 'sakura-sheet',
      GOOGLE_ARCHIVE_DRIVE_FOLDER_ID: 'sakura-audio',
      GOOGLE_ARCHIVE_TRANSCRIPT_FOLDER_ID: 'sakura-transcripts',
    };
    const target = resolveArchiveDestination('sakura-seikotsuin', loadClient, env);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    expect(target.destination).toEqual({
      sheetId: 'sakura-sheet',
      audioFolderId: 'sakura-audio',
      transcriptFolderId: 'sakura-transcripts',
    });

    const { service, jobs, sheetsById, drive } = setup({
      destinations: { 'sakura-seikotsuin': target.destination },
      vapiRoutes: routesFor('call-s'),
    });
    await jobs.enqueue('sakura-seikotsuin', 'call-s');

    await service.retryPending();

    expect([...sheetsById.keys()]).toEqual(['sakura-sheet']);
    const [range, row] = sheetsById.get('sakura-sheet')!.appendRow.mock.calls[0]!;
    expect(range).toBe('A1');
    expect(row).toEqual([
      '2026-10-12T01:00:00.000Z',
      'sakura-seikotsuin',
      'call-s',
      'ja',
      'unresolved',
      'assistant-ended-call',
      '',
      '',
      '',
    ]);
    const folders = drive.uploadFile.mock.calls.map(([request]) => request.folderId).sort();
    expect(folders).toEqual(['sakura-audio', 'sakura-transcripts']);
  });
});
