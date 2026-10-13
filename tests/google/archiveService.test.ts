import { describe, expect, test, vi } from 'vitest';

import type { ArchiveJob } from '../../src/google/archive.js';
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

function setup(options: { vapiRoutes?: Record<string, () => Response>; budgetMs?: number } = {}) {
  const jobs = new MemoryJobs();
  const sheets = {
    appendRow: vi.fn((_range: string, _values: readonly string[]) =>
      Promise.resolve('Sheet1!A5:J5'),
    ),
    updateCell: vi.fn((_range: string, _value: string) => Promise.resolve()),
  };
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
    sheets,
    drive,
    audioFolderId: 'audio-folder',
    transcriptFolderId: 'transcript-folder',
    timeZoneFor: () => 'Asia/Tokyo',
    vapi: { apiKey: 'vapi-key', fetch: vapiFetch },
    ...(options.budgetMs !== undefined ? { inlineBudgetMs: options.budgetMs } : {}),
  });
  return { service, jobs, sheets, drive };
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
