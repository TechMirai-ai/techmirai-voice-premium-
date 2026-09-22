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
import type { CallbackRequestAdminRepository } from '../repositories/callbackRequestRepository.js';
import type { StaffUserRepository } from '../repositories/staffUserRepository.js';
import { STAFF_DASHBOARD_PATH } from './staffPaths.js';
import { renderDashboardPage } from './staffViews.js';

export interface StaffDashboardRouteDeps {
  staffUsers: StaffUserRepository;
  callbacks: CallbackRequestAdminRepository;
}

export function staffDashboardRouter(deps: StaffDashboardRouteDeps): Router {
  const router = Router();
  const requireReady = [requireStaffAuth(deps.staffUsers), requirePasswordAlreadyChanged()];

  router.get('/dashboard', ...requireReady, async (_req, res) => {
    const staffUser = staffUserFromLocals(res);
    const callbacks = await deps.callbacks.listByClient(staffUser.clientId);
    res.status(200).type('html').send(renderDashboardPage({ staffUser, callbacks }));
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
