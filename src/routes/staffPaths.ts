/**
 * Staff dashboard URL constants, kept in their own module so
 * src/middleware/staffSession.ts (which redirects to these) and
 * src/routes/staffAuth.ts / staffDashboard.ts / staffViews.ts (which mount
 * and link to them) can both import without a circular dependency.
 */
export const STAFF_URL_PREFIX = '/staff';
export const STAFF_LOGIN_PATH = '/staff/login';
export const STAFF_LOGOUT_PATH = '/staff/logout';
export const STAFF_CHANGE_PASSWORD_PATH = '/staff/change-password';
/** Post-login landing URL and the old Callbacks page's URL; it now redirects to the call list (VP-14). */
export const STAFF_DASHBOARD_PATH = '/staff/dashboard';
export const STAFF_CALLS_PATH = '/staff/calls';
export const STAFF_RESERVATIONS_PATH = '/staff/reservations';
/** Where staff return to after marking a callback handled. */
export const STAFF_NEEDS_CALLBACK_PATH = `${STAFF_CALLS_PATH}?status=needs_callback`;

/** The form action that marks one callback request handled. */
export function staffCallbackHandledPath(callbackId: string): string {
  return `${STAFF_DASHBOARD_PATH}/callbacks/${encodeURIComponent(callbackId)}/handled`;
}
