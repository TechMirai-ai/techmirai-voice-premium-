/**
 * The developer archive as a service (VP-12): one entry point for the webhook (`archiveReport`,
 * right after a call, under a time budget) and one for the retry run (`retryPending`).
 *
 * The webhook must never be held hostage by Google: the staff row is already saved before this is
 * called, and `archiveReport` returns within `inlineBudgetMs` whatever happens. Whatever did not
 * finish stays `pending` in `call_archive_jobs` and is picked up by `retryPending` (a cron-called
 * route and `npm run archive:retry`). Neither method ever throws for a Google/Vapi failure.
 */
import {
  archiveJob,
  type ArchiveDeps,
  type ArchiveDrive,
  type ArchiveJob,
  type ArchiveResult,
  type ArchiveSheets,
} from './archive.js';
import { buildArchiveSource, fetchCallData, type VapiAccess } from './vapiSource.js';
import type {
  ArchiveJobRepository,
  ArchiveQueueCounts,
} from '../repositories/archiveJobRepository.js';

export const DEFAULT_INLINE_BUDGET_MS = 8_000;
export const DEFAULT_RETRY_BUDGET_MS = 50_000;
/** Claim a few at a time so a time-boxed run does not burn attempts on jobs it never starts. */
const RETRY_BATCH_SIZE = 3;

export interface ArchiveServiceDeps {
  jobs: ArchiveJobRepository;
  sheets: ArchiveSheets;
  drive: ArchiveDrive;
  audioFolderId: string;
  transcriptFolderId: string;
  timeZoneFor(clientId: string): string;
  vapi: VapiAccess;
  inlineBudgetMs?: number;
}

/** What the end-of-call-report already carries — enough to write the transcript row with no lookup. */
export interface ArchiveReportInput {
  clientId: string;
  callId: string;
  transcript: string;
  startedAt?: string | undefined;
  endedReason?: string | undefined;
  presignedMonoUrl?: string | undefined;
}

export type InlineOutcome = 'done' | 'failed' | 'deferred' | 'skipped';

export interface RetrySummary {
  claimed: number;
  done: number;
  failed: number;
  queue: ArchiveQueueCounts;
}

export interface RetryOptions {
  budgetMs?: number;
}

export class ArchiveService {
  constructor(private readonly deps: ArchiveServiceDeps) {}

  private get archiveDeps(): ArchiveDeps {
    return {
      store: this.deps.jobs,
      sheets: this.deps.sheets,
      drive: this.deps.drive,
      audioFolderId: this.deps.audioFolderId,
      transcriptFolderId: this.deps.transcriptFolderId,
      timeZoneFor: (clientId) => this.deps.timeZoneFor(clientId),
    };
  }

  /** Enqueue, then try once now. Throws only if the job cannot even be queued (a database fault). */
  async archiveReport(input: ArchiveReportInput): Promise<InlineOutcome> {
    await this.deps.jobs.enqueue(input.clientId, input.callId);
    const job = await this.deps.jobs.claimCall(input.clientId, input.callId);
    if (!job) return 'skipped'; // already done, or another worker holds it

    const source = buildArchiveSource(
      input.callId,
      {
        transcript: input.transcript,
        startedAt: input.startedAt,
        endedReason: input.endedReason,
        presignedMonoUrl: input.presignedMonoUrl,
      },
      this.deps.vapi,
    );
    const run = archiveJob(job, source, this.archiveDeps);

    let timer: NodeJS.Timeout | undefined;
    const budget = new Promise<'deferred'>((resolve) => {
      timer = setTimeout(
        () => resolve('deferred'),
        this.deps.inlineBudgetMs ?? DEFAULT_INLINE_BUDGET_MS,
      );
    });
    try {
      const winner = await Promise.race([run, budget]);
      if (winner === 'deferred') {
        void run.catch(() => undefined); // it keeps going in the background; never an unhandled rejection
        return 'deferred';
      }
      return winner.status === 'done' ? 'done' : 'failed';
    } finally {
      clearTimeout(timer);
    }
  }

  /** Claims runnable jobs a few at a time until the queue is empty or the budget is spent. */
  async retryPending(options: RetryOptions = {}): Promise<RetrySummary> {
    const deadline = Date.now() + (options.budgetMs ?? DEFAULT_RETRY_BUDGET_MS);
    let claimed = 0;
    let done = 0;
    let failed = 0;

    while (Date.now() < deadline) {
      const batch = await this.deps.jobs.claimRunnable(RETRY_BATCH_SIZE);
      if (batch.length === 0) break;
      for (const job of batch) {
        claimed += 1;
        const result = await this.retryOne(job);
        if (result.status === 'done') done += 1;
        else failed += 1;
      }
    }

    return { claimed, done, failed, queue: await this.deps.jobs.countByState() };
  }

  private async retryOne(job: ArchiveJob): Promise<ArchiveResult> {
    try {
      const data = await fetchCallData(job.callId, this.deps.vapi);
      return await archiveJob(
        job,
        buildArchiveSource(job.callId, data, this.deps.vapi),
        this.archiveDeps,
      );
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'unknown error').slice(0, 300);
      try {
        await this.deps.jobs.recordFailure(job.id, `fetch: ${message}`);
      } catch {
        // The original failure is what matters.
      }
      return { status: 'failed', phase: 'audio', message };
    }
  }
}
