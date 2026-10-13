/**
 * Server-rendered HTML for the staff dashboard (VP-5 §4.4). Plain string
 * templates, no templating engine — matching src/vapi/testPage.ts, the
 * project's existing precedent for hand-built HTML. Every dynamic value goes
 * through escapeHtml() before being written into a page: `reason` is
 * caller-controlled free text that may also hold health information (§1), so
 * this is a hard requirement, not a style choice.
 *
 * Semantic class names/ids throughout (§4.4) — no CSS exists yet, but the
 * owner's later styling pass should need no HTML restructuring.
 */
import { escapeHtml } from '../lib/htmlEscape.js';
import { STAFF_CHANGE_PASSWORD_PATH, STAFF_LOGIN_PATH } from './staffPaths.js';

export function pageShell(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg-canvas: #f8f9fa;
  --bg-surface: #ffffff;
  --bg-subtle: #f1f5f9;
  --border-light: #e2e8f0;
  --border-medium: #cbd5e1;
  --text-main: #1e293b;
  --text-sub: #475569;
  --text-muted: #94a3b8;
  --brand-navy: #1e293b;
  --brand-navy-hover: #0f172a;
  --pending-border: #d97706;
  --pending-bg: #fffdfa;
  --handled-border: #94a3b8;
  --handled-bg: #f8fafc;
  --danger-bg: #fef2f2;
  --danger-border: #fecaca;
  --danger-text: #991b1b;
}

body {
  background-color: var(--bg-canvas);
  color: var(--text-main);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
  font-size: 15px;
  line-height: 1.6;
  letter-spacing: 0.02em;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  min-height: 100vh;
}

/* Header */
.staff-header {
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-light);
  padding: 1rem 2rem;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  top: 0;
  z-index: 10;
}

.staff-header h1 {
  font-size: 1.15rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--brand-navy);
}

.logout-form {
  margin: 0;
}

#logout-button {
  background: transparent;
  border: 1px solid var(--border-medium);
  color: var(--text-sub);
  padding: 0.35rem 0.85rem;
  border-radius: 4px;
  font-size: 0.825rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all 0.15s ease;
}

#logout-button:hover {
  background: var(--bg-subtle);
  color: var(--brand-navy);
  border-color: var(--text-muted);
}

.mark-handled-form {
  display: flex;
}

.mark-handled-button {
  background: var(--brand-navy);
  color: #ffffff;
  border: 1px solid var(--brand-navy);
  border-radius: 4px;
  padding: 0.45rem 1rem;
  font-size: 0.825rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mark-handled-button:hover {
  background: var(--brand-navy-hover);
  border-color: var(--brand-navy-hover);
}

/* Section navigation and the call / reservation lists */
.staff-nav {
  max-width: none;
  margin: 1.25rem auto 0;
  padding: 0 1.5rem;
  display: flex;
  gap: 0.25rem;
  border-bottom: 1px solid var(--border-light);
}

.staff-nav a {
  padding: 0.5rem 1rem;
  color: var(--text-sub);
  text-decoration: none;
  font-size: 0.9rem;
  border-bottom: 2px solid transparent;
}

.staff-nav a[aria-current="page"] {
  color: var(--brand-navy);
  font-weight: 600;
  border-bottom-color: var(--brand-navy);
}

.call-dashboard {
  max-width: none;
  margin: 1.5rem auto 2.5rem;
  padding: 0 1.5rem;
}

.call-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 1.25rem;
}

.call-filters a {
  padding: 0.25rem 0.8rem;
  border: 1px solid var(--border-medium);
  border-radius: 999px;
  color: var(--text-sub);
  text-decoration: none;
  font-size: 0.825rem;
}

.call-filters a[aria-current="true"] {
  background: var(--brand-navy);
  border-color: var(--brand-navy);
  color: #ffffff;
}

/* Spreadsheet-style tables (VP-14): scrolls sideways on narrow screens rather than squashing. */
.table-wrap {
  overflow-x: auto;
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: 6px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.data-table th {
  position: sticky;
  top: 0;
  background: var(--bg-subtle);
  color: var(--text-sub);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-align: left;
  text-transform: uppercase;
  white-space: nowrap;
}

.data-table th,
.data-table td {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border-light);
  border-right: 1px solid var(--border-light);
  vertical-align: top;
}

.data-table th:last-child,
.data-table td:last-child { border-right: none; }
.data-table tbody tr:last-child td { border-bottom: none; }
.data-table tbody tr:nth-child(even) { background: var(--bg-canvas); }
.data-table tbody tr:hover { background: var(--bg-subtle); }

/* Only short, fixed-shape values (time, duration, ids) stay on one line. Everything else wraps, and
   text with no break points (a long URL, a string of kana) is broken rather than widening the table. */
.col-nowrap { white-space: nowrap; }
.col-caller, .col-details, .col-summary { white-space: pre-wrap; overflow-wrap: anywhere; }
.col-caller { width: 14%; }
.col-summary { width: 34%; color: var(--text-sub); }
.col-details { width: 20%; }
.col-action { width: 1%; }
.mark-handled-button { white-space: nowrap; }
.cell-empty { color: var(--text-muted); }

/* Smaller screens: tighter cells so the nine-column Needs Callback table still fits. */
@media (max-width: 1100px) {
  .data-table { font-size: 0.8rem; }
  .data-table th, .data-table td { padding: 0.45rem 0.45rem; }
}

.table-empty td {
  padding: 3rem 1.5rem;
  text-align: center;
  color: var(--text-muted);
}

.status-badge {
  display: inline-block;
  white-space: nowrap;
  padding: 0.15rem 0.65rem;
  border-radius: 999px;
  border: 1px solid var(--border-medium);
  font-size: 0.78rem;
  font-weight: 600;
}

.status-badge.status-reservation_made { color: #166534; background: #f0fdf4; border-color: #bbf7d0; }
.status-badge.status-needs_callback { color: #92400e; background: #fffbeb; border-color: #fde68a; }
.status-badge.status-resolved_by_ai { color: #1e40af; background: #eff6ff; border-color: #bfdbfe; }
.status-badge.status-unresolved { color: var(--danger-text); background: var(--danger-bg); border-color: var(--danger-border); }

.handled-label {
  display: inline-flex;
  align-items: center;
  font-size: 0.8rem;
  font-weight: 500;
  color: var(--text-sub);
  background: var(--bg-subtle);
  border: 1px solid var(--border-medium);
  border-radius: 4px;
  padding: 0.3rem 0.65rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

/* Login & Change Password Views */
.staff-login,
.staff-change-password {
  max-width: 400px;
  margin: 5rem auto;
  padding: 2.5rem 2rem;
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.03);
}

.staff-login h1,
.staff-change-password h1 {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--brand-navy);
  text-align: center;
  margin-bottom: 1.5rem;
  letter-spacing: -0.01em;
}

.change-password-intro {
  font-size: 0.875rem;
  color: var(--text-sub);
  text-align: center;
  line-height: 1.5;
  margin-bottom: 1.5rem;
}

.form-error {
  background: var(--danger-bg);
  border: 1px solid var(--danger-border);
  color: var(--danger-text);
  padding: 0.65rem 0.85rem;
  border-radius: 4px;
  font-size: 0.85rem;
  text-align: center;
  margin-bottom: 1.25rem;
}

.staff-form {
  display: flex;
  flex-direction: column;
  gap: 1.1rem;
}

.staff-form label {
  font-size: 0.775rem;
  font-weight: 600;
  color: var(--text-sub);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: -0.5rem;
}

.staff-form input[type="email"],
.staff-form input[type="password"] {
  width: 100%;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--border-medium);
  border-radius: 4px;
  font-size: 0.95rem;
  color: var(--text-main);
  background: var(--bg-surface);
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.staff-form input[type="email"]:focus,
.staff-form input[type="password"]:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}

#login-submit,
#change-password-submit {
  width: 100%;
  padding: 0.7rem;
  background: var(--brand-navy);
  color: #ffffff;
  border: 1px solid var(--brand-navy);
  border-radius: 4px;
  font-size: 0.9rem;
  font-weight: 500;
  letter-spacing: 0.03em;
  cursor: pointer;
  margin-top: 0.5rem;
  transition: all 0.15s ease;
}

#login-submit:hover,
#change-password-submit:hover {
  background: var(--brand-navy-hover);
  border-color: var(--brand-navy-hover);
}

@media (max-width: 600px) {
  .staff-header {
    padding: 1rem;
  }
  .call-dashboard,
  .staff-nav {
    padding: 0 1rem;
  }
  .staff-login,
  .staff-change-password {
    margin: 2rem 1rem;
    padding: 1.75rem 1.25rem;
  }
}
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

export interface RenderLoginPageOptions {
  error?: string;
}

export function renderLoginPage(options: RenderLoginPageOptions): string {
  const errorHtml = options.error
    ? `<p class="form-error" id="login-error">${escapeHtml(options.error)}</p>`
    : '';

  return pageShell(
    'Staff login',
    `<main class="staff-login">
  <h1>Staff login</h1>
  ${errorHtml}
  <form method="post" action="${STAFF_LOGIN_PATH}" id="login-form" class="staff-form">
    <label for="email">Email</label>
    <input type="email" name="email" id="email" required autocomplete="username" />
    <label for="password">Password</label>
    <input type="password" name="password" id="password" required autocomplete="current-password" />
    <button type="submit" id="login-submit">Log in</button>
  </form>
</main>`,
  );
}

export interface RenderChangePasswordPageOptions {
  error?: string;
}

export function renderChangePasswordPage(options: RenderChangePasswordPageOptions): string {
  const errorHtml = options.error
    ? `<p class="form-error" id="change-password-error">${escapeHtml(options.error)}</p>`
    : '';

  return pageShell(
    'Set a new password',
    `<main class="staff-change-password">
  <h1>Set a new password</h1>
  <p class="change-password-intro">
    Your account was created with a temporary password. Choose a new one before continuing.
  </p>
  ${errorHtml}
  <form method="post" action="${STAFF_CHANGE_PASSWORD_PATH}" id="change-password-form" class="staff-form">
    <label for="new-password">New password</label>
    <input type="password" name="newPassword" id="new-password" required autocomplete="new-password" minlength="12" />
    <label for="confirm-password">Confirm new password</label>
    <input type="password" name="confirmPassword" id="confirm-password" required autocomplete="new-password" minlength="12" />
    <button type="submit" id="change-password-submit">Set password</button>
  </form>
</main>`,
  );
}
