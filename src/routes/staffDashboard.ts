/**
 * The staff dashboard routes: the call list (with its Needs Callback filter, where staff mark a
 * callback handled — VP-5 §4.6, moved here in VP-14) and the reservation list. A read/act-on
 * screen, not an editor: no un-marking, no notes field, no editing of the callback's own data.
 */
import { Router } from 'express';

import { logger } from '../lib/logger.js';
import {
  requirePasswordAlreadyChanged,
  requireStaffAuth,
  staffUserFromLocals,
} from '../middleware/staffSession.js';
import type { TimeZoneLookup } from '../config/clinicTimeZone.js';
import { CALL_STATUSES, type CallStatus } from '../lib/callStatus.js';
import type { CallLogReader } from '../repositories/callLogRepository.js';
import type { CallbackRequestAdminRepository } from '../repositories/callbackRequestRepository.js';
import type { StaffUserRepository } from '../repositories/staffUserRepository.js';
import { STAFF_CALLS_PATH, STAFF_NEEDS_CALLBACK_PATH } from './staffPaths.js';
import { renderCallsPage, renderReservationsPage } from './staffCallViews.js';

export interface StaffDashboardRouteDeps {
  staffUsers: StaffUserRepository;
  callbacks: CallbackRequestAdminRepository;
  /** VP-12: summary-and-status call history. The reader exposes no transcript or audio. */
  callLogs: CallLogReader;
  /** The clinic's timezone (client.yaml), for showing stored UTC instants in local time. */
  timeZoneFor: TimeZoneLookup;
}

/** `?status=` is user input: only a known enum value is honoured, anything else means "all". */
function parseStatus(value: unknown): CallStatus | undefined {
  return CALL_STATUSES.find((status) => status === value);
}

export function staffDashboardRouter(deps: StaffDashboardRouteDeps): Router {
  const router = Router();
  const requireReady = [requireStaffAuth(deps.staffUsers), requirePasswordAlreadyChanged()];

  // The old Callbacks page: kept as the post-login landing URL, it now just opens the call list.
  router.get('/dashboard', ...requireReady, (_req, res) => {
    res.redirect(302, STAFF_CALLS_PATH);
  });

  router.get('/calls', ...requireReady, async (req, res) => {
    const staffUser = staffUserFromLocals(res);
    const statusFilter = parseStatus(req.query.status);
    // Needs Callback is driven by the callback requests themselves, so a callback is never hidden
    // by its call's derived status or by a missing call log.
    const calls =
      statusFilter === 'needs_callback'
        ? await deps.callLogs.listNeedsCallback(staffUser.clientId)
        : await deps.callLogs.listByClient(
            staffUser.clientId,
            statusFilter ? { status: statusFilter } : {},
          );
    const timeZone = deps.timeZoneFor(staffUser.clientId);
    res.status(200).type('html').send(renderCallsPage({ calls, statusFilter, timeZone }));
  });

  router.get('/reservations', ...requireReady, async (_req, res) => {
    const staffUser = staffUserFromLocals(res);
    const reservations = await deps.callLogs.listReservations(staffUser.clientId);
    const timeZone = deps.timeZoneFor(staffUser.clientId);
    res.status(200).type('html').send(renderReservationsPage({ reservations, timeZone }));
  });

  router.post('/dashboard/callbacks/:id/handled', ...requireReady, async (req, res) => {
    const staffUser = staffUserFromLocals(res);
    const id = req.params.id;
    if (typeof id !== 'string' || id.length === 0) {
      res.status(400).json({ status: 'error', error: 'bad_request' });
      return;
    }

    const updated = await deps.callbacks.markHandled(id, staffUser.clientId);
    if (!updated) {
      res.status(404).json({ status: 'error', error: 'not_found' });
      return;
    }

    logger.info('callback marked handled', { callbackId: id, clientId: staffUser.clientId });
    res.redirect(303, STAFF_NEEDS_CALLBACK_PATH);
  });

  return router;
}
