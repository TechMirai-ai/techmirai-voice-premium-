/**
 * Server-rendered pages for the call list and the reservation list (VP-12, tables in VP-14).
 * Staff see a short AI summary and a fixed status for each call — nothing else. Every field
 * rendered here comes from the allow-listed `StaffCallSummary` / `StaffReservationSummary` shapes,
 * and each dynamic value goes through escapeHtml(): the summary and names are caller-influenced
 * text. Timestamps are stored in UTC and shown in the clinic's timezone (see lib/clinicTime.ts).
 */
import { formatDuration } from '../lib/callDuration.js';
import { CALL_STATUSES, type CallStatus } from '../lib/callStatus.js';
import { formatClinicDateTime, timeZoneLabel } from '../lib/clinicTime.js';
import { DEMO_PLACEHOLDER_PHONE } from '../lib/demoCallerPhone.js';
import { escapeHtml } from '../lib/htmlEscape.js';
import type {
  StaffCallbackInfo,
  StaffCallSummary,
  StaffReservationSummary,
} from '../repositories/callLogRepository.js';
import { staffNavHtml } from './staffNav.js';
import { STAFF_CALLS_PATH, STAFF_LOGOUT_PATH, staffCallbackHandledPath } from './staffPaths.js';
import { pageShell } from './staffViews.js';

export const STATUS_LABELS: Readonly<Record<CallStatus, string>> = {
  reservation_made: 'Reservation made',
  needs_callback: 'Needs Callback',
  resolved_by_ai: 'Resolved by AI',
  unresolved: 'Unresolved',
};

/** Shown where a value is missing — e.g. no summary for a call that dropped before anything was said. */
const EMPTY_CELL = '—';

function statusBadgeHtml(status: CallStatus): string {
  const label = STATUS_LABELS[status] ?? escapeHtml(status);
  return `<span class="status-badge status-${escapeHtml(status)}">${label}</span>`;
}

function headerHtml(title: string): string {
  return `<header class="staff-header">
  <h1>${escapeHtml(title)}</h1>
  <form method="post" action="${STAFF_LOGOUT_PATH}" class="logout-form">
    <button type="submit" id="logout-button">Log out</button>
  </form>
</header>`;
}

function cellHtml(value: string | null | undefined, className = ''): string {
  const classes = [className, value ? '' : 'cell-empty'].filter(Boolean).join(' ');
  const classAttr = classes ? ` class="${classes}"` : '';
  return `<td${classAttr}>${value ? escapeHtml(value) : EMPTY_CELL}</td>`;
}

function tableHtml(id: string, headers: readonly string[], rows: readonly string[]): string {
  const head = headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join('');
  return `<div class="table-wrap">
  <table class="data-table" id="${escapeHtml(id)}">
    <thead><tr>${head}</tr></thead>
    <tbody>
    ${rows.join('\n    ')}
    </tbody>
  </table>
</div>`;
}

function emptyRowHtml(columns: number, message: string): string {
  return `<tr class="table-empty"><td colspan="${columns}">${escapeHtml(message)}</td></tr>`;
}

function callerCellHtml(call: StaffCallSummary): string {
  const parts = [
    call.callerName ? escapeHtml(call.callerName) : '',
    call.matchedPatientName ? `Patient on file: ${escapeHtml(call.matchedPatientName)}` : '',
  ].filter((part) => part.length > 0);
  return parts.length > 0
    ? `<td class="col-caller">${parts.join('<br>')}</td>`
    : `<td class="cell-empty">${EMPTY_CELL}</td>`;
}

/**
 * Phone and reason share one lowest-priority "Details" cell so the table fits a laptop screen
 * without a horizontal scrollbar. The demo placeholder is flagged so staff never mistake it for a
 * real callback number.
 */
function callbackDetailsCellHtml(callback: StaffCallbackInfo | null): string {
  const lines: string[] = [];
  if (callback?.callerPhone) {
    // TODO(SV-5): remove the placeholder label once real caller-ID numbers are stored.
    const phone = escapeHtml(callback.callerPhone);
    lines.push(
      callback.callerPhone === DEMO_PLACEHOLDER_PHONE
        ? `${phone} (demo placeholder — no caller ID)`
        : `<strong>${phone}</strong>`,
    );
  }
  if (callback?.reason) lines.push(escapeHtml(callback.reason));
  return lines.length > 0
    ? `<td class="col-details">${lines.join('<br>')}</td>`
    : `<td class="cell-empty">${EMPTY_CELL}</td>`;
}

function callbackActionHtml(callback: StaffCallbackInfo | null, timeZone: string): string {
  if (!callback) return `<td class="cell-empty">${EMPTY_CELL}</td>`;
  if (callback.status === 'pending') {
    return `<td class="col-action"><form method="post" action="${staffCallbackHandledPath(callback.id)}" class="mark-handled-form">
      <button type="submit" class="mark-handled-button">Mark as handled</button>
    </form></td>`;
  }
  const handledAt = callback.handledAt ? formatClinicDateTime(callback.handledAt, timeZone) : '';
  return `<td class="col-action"><span class="handled-label">Handled ${escapeHtml(handledAt)}</span></td>`;
}

const CALL_HEADERS = ['Language', 'Duration', 'Topic', 'Status', 'Caller', 'Summary'] as const;
const CALLBACK_HEADERS = ['Details', 'Action'] as const;

function callRowHtml(call: StaffCallSummary, timeZone: string, showCallback: boolean): string {
  const when = formatClinicDateTime(call.startedAt ?? call.createdAt, timeZone);
  const duration = call.durationSeconds === null ? null : formatDuration(call.durationSeconds);
  const callbackCells = showCallback
    ? `${callbackDetailsCellHtml(call.callback)}
      ${callbackActionHtml(call.callback, timeZone)}`
    : '';
  return `<tr class="call-row status-${escapeHtml(call.status)}" id="call-${escapeHtml(call.id)}">
      <td class="col-nowrap">${escapeHtml(when)}</td>
      ${cellHtml(call.language)}
      ${cellHtml(duration, 'col-nowrap')}
      ${cellHtml(call.topic)}
      <td>${statusBadgeHtml(call.status)}</td>
      ${callerCellHtml(call)}
      ${cellHtml(call.summary, 'col-summary')}
      ${callbackCells}
    </tr>`;
}

function filterLinksHtml(active: CallStatus | undefined): string {
  const link = (href: string, label: string, isActive: boolean): string =>
    `<a href="${href}"${isActive ? ' aria-current="true"' : ''}>${label}</a>`;
  return `<nav class="call-filters" aria-label="Filter by status">
  ${link(STAFF_CALLS_PATH, 'All', active === undefined)}
  ${CALL_STATUSES.map((status) =>
    link(`${STAFF_CALLS_PATH}?status=${status}`, STATUS_LABELS[status], active === status),
  ).join('\n  ')}
</nav>`;
}

export interface RenderCallsPageOptions {
  calls: StaffCallSummary[];
  statusFilter?: CallStatus | undefined;
  /** The clinic's IANA timezone; timestamps are shown in it. */
  timeZone: string;
}

export function renderCallsPage(options: RenderCallsPageOptions): string {
  const { timeZone } = options;
  // Mark-as-handled lives here, on the Needs Callback filter, and nowhere else (VP-14).
  const showCallback = options.statusFilter === 'needs_callback';
  const headers = [
    `Date / Time (${timeZoneLabel(timeZone)})`,
    ...CALL_HEADERS,
    ...(showCallback ? CALLBACK_HEADERS : []),
  ];
  const rows = options.calls.length
    ? options.calls.map((call) => callRowHtml(call, timeZone, showCallback))
    : [emptyRowHtml(headers.length, 'No calls yet.')];

  return pageShell(
    'All Calls',
    `${headerHtml('All Calls')}
${staffNavHtml('calls')}
<main class="call-dashboard">
  ${filterLinksHtml(options.statusFilter)}
  ${tableHtml('call-table', headers, rows)}
</main>`,
  );
}

function reservationRowHtml(reservation: StaffReservationSummary, timeZone: string): string {
  const appointment = `${reservation.appointmentDate} ${reservation.appointmentTime}`;
  const booked = formatClinicDateTime(reservation.bookedAt, timeZone);
  return `<tr class="reservation-row" id="reservation-${escapeHtml(reservation.id)}">
      <td class="col-nowrap">${escapeHtml(reservation.reservationNumber)}</td>
      <td class="col-nowrap">${escapeHtml(appointment)}</td>
      ${cellHtml(reservation.serviceName)}
      ${cellHtml(reservation.patientName)}
      ${cellHtml(reservation.isReturningPatient ? 'Returning' : 'New')}
      ${cellHtml(reservation.language)}
      <td class="col-nowrap">${escapeHtml(booked)}</td>
      ${cellHtml(reservation.summary, 'col-summary')}
    </tr>`;
}

export interface RenderReservationsPageOptions {
  reservations: StaffReservationSummary[];
  /** The clinic's IANA timezone; the booking time is shown in it. */
  timeZone: string;
}

export function renderReservationsPage(options: RenderReservationsPageOptions): string {
  const { timeZone } = options;
  const headers = [
    'Reservation #',
    'Appointment',
    'Service',
    'Patient',
    'Patient type',
    'Language',
    `Booked (${timeZoneLabel(timeZone)})`,
    'Summary',
  ];
  const rows = options.reservations.length
    ? options.reservations.map((reservation) => reservationRowHtml(reservation, timeZone))
    : [emptyRowHtml(headers.length, 'No reservations yet.')];

  return pageShell(
    'Reservations',
    `${headerHtml('Reservations')}
${staffNavHtml('reservations')}
<main class="call-dashboard">
  ${tableHtml('reservation-table', headers, rows)}
</main>`,
  );
}
