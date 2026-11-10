/** Shared fixtures for the voice webhook tests: an app with in-memory doubles and Vapi envelopes. */
import type {
  PostalCodeLookup,
  PostalCodeLookupResult,
} from '../../src/address/postalCodeLookup.js';
import { createApp } from '../../src/app.js';
import type { Queryable } from '../../src/db/pool.js';
import { FileKnowledgeSource } from '../../src/knowledge/KnowledgeSource.js';
import type { CallbackNotifier, CallbackNotification } from '../../src/lib/callbackNotifier.js';
import type { BookingNotifier } from '../../src/notifications/bookingNotifier.js';
import type { ClinicNow } from '../../src/lib/clinicTime.js';
import {
  ChangeLimitError,
  SlotTakenError,
  type AppointmentRepository,
  type BookedAppointment,
  type ChangeRequest,
  type ChangedAppointment,
  type NewAppointment,
  type RescheduleRequest,
  type UpcomingAppointment,
} from '../../src/repositories/appointmentRepository.js';
import type {
  CallbackRequestRepository,
  NewCallbackRequest,
} from '../../src/repositories/callbackRequestRepository.js';
import type {
  CallLogRepository,
  NewCallLog,
  TransferCountReader,
} from '../../src/repositories/callLogRepository.js';
import type {
  CallTopicRepository,
  NewCallTopic,
} from '../../src/repositories/callTopicRepository.js';
import {
  matchPatientsByName,
  type ReservationPatient,
  type ReservationPatientRepository,
} from '../../src/repositories/reservationPatientRepository.js';
import type {
  ReservationService,
  ReservationServiceRepository,
} from '../../src/repositories/reservationServiceRepository.js';
import type { ArchiveRetryRouteDeps } from '../../src/routes/archiveRetry.js';
import type { ReportArchiver } from '../../src/routes/endOfCallReport.js';
import type { AssistantResolver } from '../../src/vapi/assistantResolver.js';
import type { VoiceRouterOptions } from '../../src/routes/voiceRouter.js';
import type { RateLimitOptions } from '../../src/middleware/rateLimit.js';
import { buildStaffOptions } from './staffFixtures.js';
import { MemoryPriorCalls } from './priorCallFixtures.js';

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789';
export const CLIENT_ID = 'sakura-seikotsuin';
export const CALL_ID = 'call-123';
export const TOOL_CALL_ID = 'toolcall-abc';
export const AUTH = { Authorization: `Bearer ${WEBHOOK_SECRET}` };

export const CALLER_NAME = 'Hanako Yamada';
export const CALLER_PHONE = '090-1234-5678';

export const healthyDb: Queryable = { query: () => Promise.resolve({ rows: [] }) };

export class MemoryCallbacks implements CallbackRequestRepository {
  readonly saved: NewCallbackRequest[] = [];
  failWith: Error | undefined;

  create(request: NewCallbackRequest): Promise<CallbackNotification> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.saved.push(request);
    return Promise.resolve({ ...request, id: 'cb-1', createdAt: new Date(0) });
  }
}

export class MemoryTopics implements CallTopicRepository {
  readonly recorded: NewCallTopic[] = [];
  failWith: Error | undefined;

  record(topic: NewCallTopic): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.recorded.push(topic);
    return Promise.resolve();
  }
}

export class MemoryCallLogs implements CallLogRepository {
  readonly recorded: NewCallLog[] = [];
  failWith: Error | undefined;

  record(log: NewCallLog): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.recorded.push(log);
    return Promise.resolve();
  }
}

export class MemoryNotifier implements CallbackNotifier {
  readonly notified: CallbackNotification[] = [];
  failWith: Error | undefined;

  notify(callback: CallbackNotification): Promise<void> {
    if (this.failWith) return Promise.reject(this.failWith);
    this.notified.push(callback);
    return Promise.resolve();
  }
}

/** A single fixed demo service: "general-consultation" (30 min). */
export class MemoryReservationServices implements ReservationServiceRepository {
  services: ReservationService[] = [
    {
      id: 'general-consultation',
      name: { ja: '一般施術', en: 'General Consultation' },
      durationMinutes: 30,
    },
  ];

  listByClient(): Promise<ReservationService[]> {
    return Promise.resolve(this.services);
  }
}

/** VP-20: a postal-code lookup that answers a scripted result and records what it was asked. */
export class MemoryPostalCodes implements PostalCodeLookup {
  result: PostalCodeLookupResult = {
    kind: 'found',
    addresses: [
      {
        prefecture: '東京都',
        city: '渋谷区',
        town: '渋谷',
        prefectureKana: 'トウキョウト',
        cityKana: 'シブヤク',
        townKana: 'シブヤ',
      },
    ],
  };
  readonly asked: string[] = [];

  lookup(rawPostalCode: string): Promise<PostalCodeLookupResult> {
    this.asked.push(rawPostalCode);
    return Promise.resolve(this.result);
  }
}

/** Knows one fake returning patient, 'ヤマダ タロウ'. */
export class MemoryReservationPatients implements ReservationPatientRepository {
  patients: ReservationPatient[] = [{ name: 'ヤマダ タロウ' }];

  findByName(_clientId: string, name: string): Promise<ReservationPatient | undefined> {
    const matches = matchPatientsByName(
      this.patients.map((patient) => patient.name),
      name,
    );
    return Promise.resolve(matches.length === 1 ? { name: matches[0]! } : undefined);
  }
}

/** A stored booking in the in-memory double — the fields the VP-25 change tools read and write. */
export interface MemoryAppointmentRow {
  id: string;
  clientId: string;
  phone: string;
  date: string;
  time: string;
  serviceName: string | null;
  patientName: string;
  reservationNumber: string;
  language: string;
  status: 'active' | 'cancelled';
}

/** One audit row, like `appointment_changes` — no names or phone numbers. */
export interface MemoryChange {
  appointmentId: string;
  callId: string;
  action: 'cancelled' | 'rescheduled';
  oldDate: string;
  oldTime: string;
  newDate?: string;
  newTime?: string;
}

/**
 * In-memory double that follows the real repository's rules (src/repositories/appointmentRepository.ts):
 * only the caller's own active, upcoming booking can be changed; one change per call; one live
 * booking per slot; a cancelled booking frees its slot.
 */
export class MemoryAppointments implements AppointmentRepository {
  readonly booked: NewAppointment[] = [];
  readonly rows: MemoryAppointmentRow[] = [];
  readonly changes: MemoryChange[] = [];
  taken: Record<string, string[]> = {};
  failWith: Error | undefined;

  /** Adds a stored booking; unspecified fields get sensible defaults. */
  seed(row: Partial<MemoryAppointmentRow> = {}): MemoryAppointmentRow {
    const index = this.rows.length + 1;
    const seeded: MemoryAppointmentRow = {
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      clientId: CLIENT_ID,
      phone: '09012345678',
      date: '2026-11-12',
      time: '10:00',
      serviceName: 'General Consultation',
      patientName: 'Hanako Yamada',
      reservationNumber: `R9${String(index).padStart(5, '0')}`,
      language: 'ja',
      status: 'active',
      ...row,
    };
    this.rows.push(seeded);
    return seeded;
  }

  listTakenTimes(clientId: string, date: string): Promise<Set<string>> {
    const live = this.rows
      .filter((row) => row.clientId === clientId && row.date === date && row.status === 'active')
      .map((row) => row.time);
    return Promise.resolve(new Set([...(this.taken[date] ?? []), ...live]));
  }

  listUpcomingForPhone(
    clientId: string,
    phone: string,
    now: ClinicNow,
    limit: number,
  ): Promise<UpcomingAppointment[]> {
    if (this.failWith) return Promise.reject(this.failWith);
    const upcoming = this.rows
      .filter((row) => this.isChangeable(row, clientId, phone, now))
      .sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`))
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        reservationNumber: row.reservationNumber,
        serviceName: row.serviceName,
        appointmentDate: row.date,
        appointmentTime: row.time,
      }));
    return Promise.resolve(upcoming);
  }

  cancel(request: ChangeRequest): Promise<ChangedAppointment | undefined> {
    return this.settle(() => this.change(request, undefined));
  }

  reschedule(request: RescheduleRequest): Promise<ChangedAppointment | undefined> {
    return this.settle(() =>
      this.change(request, { date: request.newDate, time: request.newTime }),
    );
  }

  private settle<T>(work: () => T): Promise<T> {
    try {
      if (this.failWith) throw this.failWith;
      return Promise.resolve(work());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('failed'));
    }
  }

  private isChangeable(
    row: MemoryAppointmentRow,
    clientId: string,
    phone: string,
    now: ClinicNow,
  ): boolean {
    return (
      row.clientId === clientId &&
      row.phone === phone &&
      row.status === 'active' &&
      `${row.date} ${row.time}` > `${now.date} ${now.time}`
    );
  }

  private change(
    request: ChangeRequest,
    moveTo: { date: string; time: string } | undefined,
  ): ChangedAppointment | undefined {
    const row = this.rows.find(
      (candidate) =>
        candidate.id === request.appointmentId &&
        this.isChangeable(candidate, request.clientId, request.phone, request.now),
    );
    if (!row) return undefined;
    if (this.changes.some((change) => change.callId === request.callId)) {
      throw new ChangeLimitError();
    }
    if (
      moveTo &&
      this.rows.some(
        (other) =>
          other !== row &&
          other.clientId === row.clientId &&
          other.status === 'active' &&
          other.date === moveTo.date &&
          other.time === moveTo.time,
      )
    ) {
      throw new SlotTakenError();
    }

    const { date: oldDate, time: oldTime } = row;
    if (moveTo) {
      row.date = moveTo.date;
      row.time = moveTo.time;
    } else {
      row.status = 'cancelled';
    }
    this.changes.push({
      appointmentId: row.id,
      callId: request.callId,
      action: moveTo ? 'rescheduled' : 'cancelled',
      oldDate,
      oldTime,
      ...(moveTo ? { newDate: moveTo.date, newTime: moveTo.time } : {}),
    });
    return {
      id: row.id,
      reservationNumber: row.reservationNumber,
      serviceName: row.serviceName,
      patientName: row.patientName,
      language: row.language,
      oldDate,
      oldTime,
      ...(moveTo ? { newDate: moveTo.date, newTime: moveTo.time } : {}),
    };
  }

  create(appointment: NewAppointment): Promise<BookedAppointment> {
    if (this.failWith) return Promise.reject(this.failWith);
    // Like the unique index: one live booking per slot.
    const held = this.rows.some(
      (row) =>
        row.clientId === appointment.clientId &&
        row.status === 'active' &&
        row.date === appointment.appointmentDate &&
        row.time === appointment.appointmentTime,
    );
    if (held) return Promise.reject(new SlotTakenError());
    this.booked.push(appointment);
    // The fixed id and number are what the booking tests assert on (not a UUID: a booking made
    // through `create` is not reachable by the change tools — seed() one for those).
    this.rows.push({
      id: 'appt-1',
      clientId: appointment.clientId,
      phone: appointment.patientPhone,
      date: appointment.appointmentDate,
      time: appointment.appointmentTime,
      serviceName: appointment.serviceName,
      patientName: appointment.patientName,
      reservationNumber: 'R000001',
      language: appointment.language,
      status: 'active',
    });
    return Promise.resolve({
      ...appointment,
      id: 'appt-1',
      reservationNumber: 'R000001',
      createdAt: new Date(0),
    });
  }

  findChangeInCall(
    clientId: string,
    callId: string,
    appointmentId: string,
    phone: string,
  ): Promise<ChangedAppointment | undefined> {
    const change = this.changes.find(
      (entry) => entry.callId === callId && entry.appointmentId === appointmentId,
    );
    const row = this.rows.find(
      (entry) => entry.id === appointmentId && entry.clientId === clientId && entry.phone === phone,
    );
    if (!change || !row) return Promise.resolve(undefined);
    return Promise.resolve({
      id: row.id,
      reservationNumber: row.reservationNumber,
      serviceName: row.serviceName,
      patientName: row.patientName,
      language: row.language,
      oldDate: change.oldDate,
      oldTime: change.oldTime,
      ...(change.newDate !== undefined && change.newTime !== undefined
        ? { newDate: change.newDate, newTime: change.newTime }
        : {}),
    });
  }
}

/** Knows one assistant: `sakura-seikotsuin--ja`, id `assistant-ja`. */
export const resolver: AssistantResolver = {
  resolve: (ref) =>
    ref.id === 'assistant-ja' || ref.name === 'sakura-seikotsuin--ja'
      ? { clientId: CLIENT_ID, language: 'ja' }
      : undefined,
};

export function buildVoiceApp(
  options: {
    rateLimit?: RateLimitOptions;
    archive?: ReportArchiver;
    archiveRetry?: ArchiveRetryRouteDeps;
    /** Replaces the global `fetch` the silence-end route uses to reach Vapi (VP-16). */
    fetchImpl?: typeof fetch;
    /** VP-23: what the booking route tells after a booking. Omitted = no notifications. */
    bookingNotifier?: BookingNotifier;
    /** VP-24: stored transfers for the daily cap; default none. */
    transferCounts?: TransferCountReader;
    /** VP-24: the staff number's env lookup; default unset (so every transfer is refused). */
    transferEnv?: (name: string) => string | undefined;
    /** VP-24: the clock the transfer gate reads. */
    now?: () => Date;
  } = {},
) {
  const callbacks = new MemoryCallbacks();
  const topics = new MemoryTopics();
  const callLogs = new MemoryCallLogs();
  const notifier = new MemoryNotifier();
  const services = new MemoryReservationServices();
  const patients = new MemoryReservationPatients();
  const appointments = new MemoryAppointments();
  const postalCodes = new MemoryPostalCodes();
  const voiceOptions: VoiceRouterOptions = {
    webhookSecret: WEBHOOK_SECRET,
    resolver,
    knowledge: new FileKnowledgeSource(),
    callbacks,
    topics,
    callLogs,
    notifier,
    services,
    patients,
    appointments,
    postalCodes,
    transferCounts: options.transferCounts ?? { countTransfersSince: () => Promise.resolve(0) },
    transferEnv: options.transferEnv ?? (() => undefined),
    ...(options.now ? { now: options.now } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.archive ? { archive: options.archive } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.bookingNotifier ? { bookingNotifier: options.bookingNotifier } : {}),
  };
  const app = createApp({
    db: healthyDb,
    isProduction: false,
    voice: voiceOptions,
    ...(options.archiveRetry ? { archiveRetry: options.archiveRetry } : {}),
    staff: buildStaffOptions(),
    talk: {
      publicKey: 'test-vapi-public-key',
      rateLimitSecret: 'test-talk-rate-limit-secret-0123456789',
      bypassKey: 'test-talk-bypass-key',
      isProduction: false,
      callLogs: new MemoryPriorCalls(),
    },
  });
  return {
    app,
    callbacks,
    topics,
    callLogs,
    notifier,
    services,
    patients,
    appointments,
    postalCodes,
    voiceOptions,
  };
}

type ToolCallShape = 'sdk' | 'docs';

/** A tool-calls envelope in either of the two shapes Vapi's SDK types and docs describe. */
export function toolCallsBody(
  toolName: string,
  args: Record<string, unknown>,
  shape: ToolCallShape = 'sdk',
  overrides: { assistant?: Record<string, unknown> | null; callId?: string } = {},
) {
  const toolCall =
    shape === 'sdk'
      ? {
          id: TOOL_CALL_ID,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }
      : { id: TOOL_CALL_ID, name: toolName, parameters: args };

  return {
    message: {
      type: 'tool-calls',
      call: { id: overrides.callId ?? CALL_ID, squadId: 'squad-1' },
      ...(overrides.assistant === null
        ? {}
        : {
            assistant: overrides.assistant ?? { id: 'assistant-ja', name: 'sakura-seikotsuin--ja' },
          }),
      toolCallList: [toolCall],
      toolWithToolCallList: [{ type: 'function', toolCall }],
    },
  };
}

/** The `call` fields Vapi echoes when the /talk page started the call with a phone number (VP-15). */
export function callWithEnteredPhone(callerPhone: string) {
  return { assistantOverrides: { variableValues: { callerPhone } } };
}
