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
export const STAFF_DASHBOARD_PATH = '/staff/dashboard';
