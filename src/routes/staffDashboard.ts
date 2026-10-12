/**
 * The callback-requests dashboard (VP-5 §4.6): a read/act-on-callbacks
 * screen, not an editor — list callbacks for the logged-in staff member's
 * client, and mark one as handled. No un-marking, no notes field, no editing
 * the callback's own data.
 */
import { Router } from 'express';

import { logger } from '../lib/logger.js';
import {
  requirePasswordAlreadyChanged,
  requireStaffAuth,
  staffUserFromLocals,
} from '../middleware/staffSession.js';
import { CALL_STATUSES, type CallStatus } from '../lib/callStatus.js';
import type { CallLogReader } from '../repositories/callLogRepository.js';
import type { CallbackRequestAdminRepository } from '../repositories/callbackRequestRepository.js';
import type { StaffUserRepository } from '../repositories/staffUserRepository.js';
import { STAFF_DASHBOARD_PATH } from './staffPaths.js';
import { renderCallsPage, renderReservationsPage } from './staffCallViews.js';
import { renderDashboardPage } from './staffViews.js';

export interface StaffDashboardRouteDeps {
  staffUsers: StaffUserRepository;
  callbacks: CallbackRequestAdminRepository;
  /** VP-12: summary-and-status call history. The reader exposes no transcript or audio. */
  callLogs: CallLogReader;
}

/** `?status=` is user input: only a known enum value is honoured, anything else means "all". */
function parseStatus(value: unknown): CallStatus | undefined {
  return CALL_STATUSES.find((status) => status === value);
}

export function staffDashboardRouter(deps: StaffDashboardRouteDeps): Router {
  const router = Router();
  const requireReady = [requireStaffAuth(deps.staffUsers), requirePasswordAlreadyChanged()];

  router.get('/dashboard', ...requireReady, async (_req, res) => {
    const staffUser = staffUserFromLocals(res);
    const callbacks = await deps.callbacks.listByClient(staffUser.clientId);
    res.status(200).type('html').send(renderDashboardPage({ staffUser, callbacks }));
  });

  router.get('/calls', ...requireReady, async (req, res) => {
    const staffUser = staffUserFromLocals(res);
    const statusFilter = parseStatus(req.query.status);
    const calls = await deps.callLogs.listByClient(
      staffUser.clientId,
      statusFilter ? { status: statusFilter } : {},
    );
    res.status(200).type('html').send(renderCallsPage({ calls, statusFilter }));
  });

  router.get('/reservations', ...requireReady, async (_req, res) => {
    const staffUser = staffUserFromLocals(res);
    const reservations = await deps.callLogs.listReservations(staffUser.clientId);
    res.status(200).type('html').send(renderReservationsPage({ reservations }));
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
    res.redirect(303, STAFF_DASHBOARD_PATH);
  });

  return router;
}
