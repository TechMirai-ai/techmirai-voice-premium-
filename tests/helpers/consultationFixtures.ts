/** In-memory stand-ins for the consultation tests (the real repository is tested against Postgres). */
import type {
  ConsultationNotification,
  ConsultationNotifier,
} from '../../src/notifications/bookingNotifier.js';
import type { SmsOutcome } from '../../src/notifications/notificationJobs.js';
import type {
  ConsultationRequest,
  ConsultationRequestRepository,
  ConsultationStatus,
  CreateResult,
  NewConsultationRequest,
  UpdateStatusResult,
} from '../../src/repositories/consultationRequestRepository.js';
import type { AssistantResolver } from '../../src/vapi/assistantResolver.js';

export const TECHMIRAI_ID = 'techmirai-ai';

/** Knows one assistant: `techmirai-ai--ja`. */
export const techmiraiResolver: AssistantResolver = {
  resolve: (ref) =>
    ref.id === 'tm-assistant-ja' || ref.name === 'techmirai-ai--ja'
      ? { clientId: TECHMIRAI_ID, language: 'ja' }
      : undefined,
};

export const TECHMIRAI_ASSISTANT = { id: 'tm-assistant-ja', name: 'techmirai-ai--ja' };

export class MemoryConsultations implements ConsultationRequestRepository {
  readonly rows: ConsultationRequest[] = [];
  private seq = 0;

  create(request: NewConsultationRequest): Promise<CreateResult> {
    const existing = this.rows.find(
      (row) => row.clientId === request.clientId && row.callId === request.callId,
    );
    if (existing) return Promise.resolve({ request: existing, created: false });
    this.seq += 1;
    const row: ConsultationRequest = {
      id: `req-${this.seq}`,
      clientId: request.clientId,
      callId: request.callId,
      language: request.language,
      contactName: request.contactName,
      contactPhone: request.contactPhone,
      phoneSource: request.phoneSource,
      reason: request.reason,
      status: 'new',
      details: request.details ?? {},
      createdAt: new Date('2026-11-16T03:00:00Z'),
      updatedAt: new Date('2026-11-16T03:00:00Z'),
    };
    this.rows.push(row);
    return Promise.resolve({ request: row, created: true });
  }

  listByClient(clientId: string, status?: ConsultationStatus): Promise<ConsultationRequest[]> {
    return Promise.resolve(
      this.rows.filter((row) => row.clientId === clientId && (!status || row.status === status)),
    );
  }

  countByPhoneSince(
    clientId: string,
    phone: string,
    since: Date,
    exceptRequestId: string,
  ): Promise<number> {
    return Promise.resolve(
      this.rows.filter(
        (row) =>
          row.clientId === clientId &&
          row.contactPhone === phone &&
          row.createdAt >= since &&
          row.id !== exceptRequestId,
      ).length,
    );
  }

  updateStatus(
    id: string,
    clientId: string,
    status: ConsultationStatus,
  ): Promise<UpdateStatusResult> {
    const row = this.rows.find((entry) => entry.id === id && entry.clientId === clientId);
    return Promise.resolve(row ? { found: true, request: { ...row, status } } : { found: false });
  }
}

export class RecordingConsultationNotifier implements ConsultationNotifier {
  readonly calls: ConsultationNotification[] = [];
  /** How the caller's SMS "ended" for every notification; a test sets it to simulate a skip. */
  outcome: SmsOutcome = { status: 'sent' };

  notifyConsultation(request: ConsultationNotification): Promise<SmsOutcome> {
    this.calls.push(request);
    return Promise.resolve(this.outcome);
  }
}
