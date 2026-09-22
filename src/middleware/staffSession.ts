/**
 * Session-based auth for the staff dashboard (VP-5). Two gates, applied in
 * order:
 *   1. requireStaffAuth — a valid session, re-checked against the database
 *      on every request (so a deleted/changed account is caught immediately,
 *      not only at next login).
 *   2. requirePasswordAlreadyChanged — for every route except the
 *      change-password page and logout, the account must have completed its
 *      forced first password change (§4.7). The dashboard is genuinely
 *      unreachable until then, not just hidden behind a dismissible prompt.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { StaffUser, StaffUserRepository } from '../repositories/staffUserRepository.js';
import { STAFF_CHANGE_PASSWORD_PATH, STAFF_LOGIN_PATH } from '../routes/staffPaths.js';

declare global {
  // Augmenting Express's Response.locals requires the ambient `namespace`
  // pattern @types/express itself uses — there is no other way to extend it.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Locals {
      staffUser?: StaffUser;
    }
  }
}

export function requireStaffAuth(repo: StaffUserRepository): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const staffUserId = req.session.staffUserId;
    if (!staffUserId) {
      res.redirect(303, STAFF_LOGIN_PATH);
      return;
    }

    const staffUser = await repo.findById(staffUserId);
    if (!staffUser) {
      delete req.session.staffUserId;
      res.redirect(303, STAFF_LOGIN_PATH);
      return;
    }

    res.locals.staffUser = staffUser;
    next();
  };
}

export function requirePasswordAlreadyChanged(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    if (res.locals.staffUser?.mustChangePassword) {
      res.redirect(303, STAFF_CHANGE_PASSWORD_PATH);
      return;
    }
    next();
  };
}

/**
 * Reads the staffUser requireStaffAuth attached to res.locals. Throws (never
 * silently falls back) if called on a route that skipped requireStaffAuth —
 * that is a routing bug, not a runtime condition to handle gracefully.
 */
export function staffUserFromLocals(res: Response): StaffUser {
  const staffUser = res.locals.staffUser;
  if (!staffUser) {
    throw new Error(
      'staffUserFromLocals: no staffUser on res.locals — was requireStaffAuth applied?',
    );
  }
  return staffUser;
}
