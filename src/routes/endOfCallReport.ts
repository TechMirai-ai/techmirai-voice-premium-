/**
 * POST /api/voice/end-of-call-report — Vapi's post-call report (VP-12, FUTURE-FEATURES F-10).
 *
 * Writes the staff-visible summary/status row. It runs behind the same rate
 * limit and Custom Credential auth as every other voice webhook (voiceRouter.ts).
 *
 * Failure policy differs from the tool webhooks: there is no assistant waiting
 * for an answer, so a database failure is a real 500 (visible in Vapi's webhook
 * log) rather than a spoken fallback. An unmatched assistant is answered 200 —
 * retrying cannot help — and logged as an error.
 */
import { Router, type Request, type Response } from 'express';

import type { ArchiveReportInput, InlineOutcome } from '../google/archiveService.js';
import { deriveCallStatus } from '../lib/callStatus.js';
import { summarizeError } from '../lib/errorSummary.js';
import { logger } from '../lib/logger.js';
import type { CallLogRepository, NewCallLog } from '../repositories/callLogRepository.js';
import type { AssistantRef, AssistantResolver } from '../vapi/assistantResolver.js';
import { parseEndOfCallReport, type EndOfCallReport } from '../vapi/endOfCallReport.js';

export const END_OF_CALL_REPORT_PATH = '/end-of-call-report';

/** The developer archive (full transcript + audio). Optional: off until Google is configured. */
export interface ReportArchiver {
  archiveReport(input: ArchiveReportInput): Promise<InlineOutcome>;
}

export interface EndOfCallReportRouteDeps {
  resolver: AssistantResolver;
  callLogs: CallLogRepository;
  archive?: ReportArchiver;
}

/**
 * Runs after the staff row is safely saved. A failure here is logged and swallowed: the archive has
 * its own retry queue, and Google trouble must never turn a saved call into a failed webhook.
 */
async function archiveSafely(
  archive: ReportArchiver | undefined,
  input: ArchiveReportInput,
): Promise<void> {
  if (!archive) return;
  try {
    const outcome = await archive.archiveReport(input);
    logger.info('call archive attempted', {
      clientId: input.clientId,
      callId: input.callId,
      outcome,
    });
  } catch (error) {
    logger.error('call archive failed to start', {
      clientId: input.clientId,
      callId: input.callId,
      ...summarizeError(error),
    });
  }
}

function safeResolve(resolver: AssistantResolver, ref: AssistantRef) {
  try {
    return resolver.resolve(ref);
  } catch (error) {
    logger.error('assistant resolver failed', { ...summarizeError(error) });
    return undefined;
  }
}

function toCallLog(
  report: EndOfCallReport,
  clientId: string,
  language: string,
  status: NewCallLog['status'],
): NewCallLog {
  return {
    clientId,
    callId: report.callId,
    language,
    status,
    ...(report.callerName ? { callerName: report.callerName } : {}),
    ...(report.callerPhone ? { callerPhone: report.callerPhone } : {}),
    ...(report.matchedPatientName ? { matchedPatientName: report.matchedPatientName } : {}),
    ...(report.topic ? { topic: report.topic } : {}),
    ...(report.summary ? { summary: report.summary } : {}),
    ...(report.endedReason ? { endedReason: report.endedReason } : {}),
    ...(report.startedAt ? { startedAt: report.startedAt } : {}),
    ...(report.endedAt ? { endedAt: report.endedAt } : {}),
  };
}

export function endOfCallReportRouter(deps: EndOfCallReportRouteDeps): Router {
  const router = Router();

  router.post(END_OF_CALL_REPORT_PATH, async (req: Request, res: Response): Promise<void> => {
    const report = parseEndOfCallReport(req.body);
    if (!report) {
      logger.warn('webhook rejected: not an end-of-call-report', { path: req.path });
      res.status(400).json({ status: 'error', error: 'bad_request' });
      return;
    }

    const resolved = safeResolve(deps.resolver, report.assistant);
    if (!resolved) {
      logger.error('end-of-call-report: assistant could not be resolved to a client', {
        callId: report.callId,
      });
      res.status(200).json({ status: 'ignored' });
      return;
    }

    const status = deriveCallStatus({
      toolResults: report.toolResults,
      resolved: report.resolved,
    });
    await deps.callLogs.record(toCallLog(report, resolved.clientId, resolved.language, status));
    logger.info('call logged', { clientId: resolved.clientId, callId: report.callId, status });

    await archiveSafely(deps.archive, {
      clientId: resolved.clientId,
      callId: report.callId,
      transcript: report.transcript,
      startedAt: report.startedAt,
      endedReason: report.endedReason,
      presignedMonoUrl: report.recordingUrl,
    });

    res.status(200).json({ status: 'ok' });
  });

  return router;
}
