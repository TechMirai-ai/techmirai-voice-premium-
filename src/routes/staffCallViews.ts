/**
 * Server-rendered pages for the call list and the reservation list (VP-12). Staff see a short AI
 * summary and a fixed status for each call — nothing else. Every field rendered here comes from the
 * allow-listed `StaffCallSummary` / `StaffReservationSummary` shapes, and each dynamic value goes
 * through escapeHtml(): the summary and names are caller-influenced text.
 */
import { formatDuration } from '../lib/callDuration.js';
import { CALL_STATUSES, type CallStatus } from '../lib/callStatus.js';
import { escapeHtml } from '../lib/htmlEscape.js';
import type {
  StaffCallSummary,
  StaffReservationSummary,
} from '../repositories/callLogRepository.js';
import { staffNavHtml } from './staffNav.js';
import { STAFF_CALLS_PATH, STAFF_LOGOUT_PATH } from './staffPaths.js';
import { pageShell } from './staffViews.js';

export const STATUS_LABELS: Readonly<Record<CallStatus, string>> = {
  reservation_made: 'Reservation made',
  needs_callback: 'Needs Callback',
  resolved_by_ai: 'Resolved by AI',
  unresolved: 'Unresolved',
};

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

function whenOf(call: StaffCallSummary): string {
  return (call.startedAt ?? call.createdAt).toISOString();
}

function peopleHtml(call: StaffCallSummary): string {
  const parts = [
    call.callerName ? `Caller: ${escapeHtml(call.callerName)}` : '',
    call.matchedPatientName ? `Patient on file: ${escapeHtml(call.matchedPatientName)}` : '',
  ].filter((part) => part.length > 0);
  return parts.length > 0 ? `<p class="call-people">${parts.join(' · ')}</p>` : '';
}

function summaryHtml(call: StaffCallSummary): string {
  return call.summary
    ? `<p class="call-summary">${escapeHtml(call.summary)}</p>`
    : '<p class="call-summary call-summary-empty">(no summary)</p>';
}

function metaHtml(call: StaffCallSummary): string {
  const topic = call.topic ? ` · Topic: ${escapeHtml(call.topic)}` : '';
  const duration =
    call.durationSeconds === null ? '' : ` · Duration: ${formatDuration(call.durationSeconds)}`;
  return `<p class="call-meta">${escapeHtml(whenOf(call))} · Language: ${escapeHtml(call.language)}${duration}${topic}</p>`;
}

function callRowHtml(call: StaffCallSummary): string {
  return `<li class="call-row status-${escapeHtml(call.status)}" id="call-${escapeHtml(call.id)}">
    ${statusBadgeHtml(call.status)}
    ${peopleHtml(call)}
    ${metaHtml(call)}
    ${summaryHtml(call)}
  </li>`;
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
}

export function renderCallsPage(options: RenderCallsPageOptions): string {
  const rows = options.calls.length
    ? options.calls.map(callRowHtml).join('\n')
    : '<li class="call-row-empty">No calls yet.</li>';

  return pageShell(
    'All Calls',
    `${headerHtml('All Calls')}
${staffNavHtml('calls')}
<main class="call-dashboard">
  ${filterLinksHtml(options.statusFilter)}
  <ul class="call-list" id="call-list">
    ${rows}
  </ul>
</main>`,
  );
}

function reservationDetailsHtml(reservation: StaffReservationSummary): string {
  if (!reservation.reservationNumber) {
    return '<p class="reservation-details reservation-details-missing">Booking details unavailable.</p>';
  }
  const when = [reservation.appointmentDate, reservation.appointmentTime]
    .filter((part): part is string => part !== null)
    .map(escapeHtml)
    .join(' ');
  const service = reservation.serviceName ? ` · ${escapeHtml(reservation.serviceName)}` : '';
  return `<p class="reservation-details"><strong>Reservation ${escapeHtml(reservation.reservationNumber)}</strong> — ${when}${service}</p>`;
}

function reservationRowHtml(reservation: StaffReservationSummary): string {
  return `<li class="call-row status-${escapeHtml(reservation.status)}" id="reservation-${escapeHtml(reservation.id)}">
    ${statusBadgeHtml(reservation.status)}
    ${reservationDetailsHtml(reservation)}
    ${peopleHtml(reservation)}
    ${metaHtml(reservation)}
    ${summaryHtml(reservation)}
  </li>`;
}

export interface RenderReservationsPageOptions {
  reservations: StaffReservationSummary[];
}

export function renderReservationsPage(options: RenderReservationsPageOptions): string {
  const rows = options.reservations.length
    ? options.reservations.map(reservationRowHtml).join('\n')
    : '<li class="call-row-empty">No reservations yet.</li>';

  return pageShell(
    'Reservations',
    `${headerHtml('Reservations')}
${staffNavHtml('reservations')}
<main class="call-dashboard">
  <ul class="call-list" id="reservation-list">
    ${rows}
  </ul>
</main>`,
  );
}
