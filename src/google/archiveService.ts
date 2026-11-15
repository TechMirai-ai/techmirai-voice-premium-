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
import { logger } from '../lib/logger.js';
import type { ArchiveDestination, DestinationResolver } from './archiveDestination.js';
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
  /** A Sheets client for one spreadsheet id (each client has its own Sheet). */
  sheetsFor(sheetId: string): ArchiveSheets;
  drive: ArchiveDrive;
  /** Where THIS client's calls go; fails closed (see ./archiveDestination.ts). */
  destinationFor: DestinationResolver;
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

  private archiveDepsFor(destination: ArchiveDestination): ArchiveDeps {
    return {
      store: this.deps.jobs,
      sheets: this.deps.sheetsFor(destination.sheetId),
      drive: this.deps.drive,
      audioFolderId: destination.audioFolderId,
      transcriptFolderId: destination.transcriptFolderId,
      timeZoneFor: (clientId) => this.deps.timeZoneFor(clientId),
    };
  }

  /**
   * Fail closed: no destination, so no Google (or Vapi) call at all. The reason is stored on the job,
   * which stays `pending` — never terminally failed — so it is archived by a later retry run once
   * the client's archive variables exist. The staff call log was saved before this ran.
   */
  private async blocked(job: ArchiveJob, message: string): Promise<ArchiveResult> {
    logger.warn('archive destination not configured', { clientId: job.clientId });
    try {
      await this.deps.jobs.recordBlocked(job.id, message);
    } catch {
      // The reason is only informational; the job itself is untouched and still pending.
    }
    return { status: 'failed', phase: 'destination', message };
  }

  /** Enqueue, then try once now. Throws only if the job cannot even be queued (a database fault). */
  async archiveReport(input: ArchiveReportInput): Promise<InlineOutcome> {
    await this.deps.jobs.enqueue(input.clientId, input.callId);
    const job = await this.deps.jobs.claimCall(input.clientId, input.callId);
    if (!job) return 'skipped'; // already done, or another worker holds it

    const target = this.deps.destinationFor(job.clientId);
    if (!target.ok) {
      await this.blocked(job, target.message);
      return 'failed';
    }

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
    const run = archiveJob(job, source, this.archiveDepsFor(target.destination));

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
    const target = this.deps.destinationFor(job.clientId);
    if (!target.ok) return this.blocked(job, target.message);

    try {
      const data = await fetchCallData(job.callId, this.deps.vapi);
      return await archiveJob(
        job,
        buildArchiveSource(job.callId, data, this.deps.vapi),
        this.archiveDepsFor(target.destination),
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
