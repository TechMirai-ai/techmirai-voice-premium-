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
import type { CallbackRequestSummary } from '../repositories/callbackRequestRepository.js';
import type { StaffUser } from '../repositories/staffUserRepository.js';
import {
  STAFF_CHANGE_PASSWORD_PATH,
  STAFF_DASHBOARD_PATH,
  STAFF_LOGIN_PATH,
  STAFF_LOGOUT_PATH,
} from './staffPaths.js';

function pageShell(title: string, bodyHtml: string): string {
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

/* Dashboard Container */
.callback-dashboard {
  max-width: 860px;
  margin: 2.5rem auto;
  padding: 0 1.5rem;
}

.callback-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.callback-row-empty {
  background: var(--bg-surface);
  border: 1px dashed var(--border-medium);
  border-radius: 6px;
  padding: 3.5rem 1.5rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.95rem;
  letter-spacing: 0.03em;
}

/* Callback Card */
.callback-row {
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: 6px;
  padding: 1.25rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
  transition: box-shadow 0.2s ease, border-color 0.2s ease;
}

.callback-row:hover {
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.04);
}

.callback-row.status-pending {
  border-left: 4px solid var(--pending-border);
  background: var(--pending-bg);
}

.callback-row.status-handled {
  border-left: 4px solid var(--handled-border);
  background: var(--handled-bg);
  opacity: 0.88;
}

.callback-caller {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--brand-navy);
  letter-spacing: 0.01em;
}

.callback-meta {
  font-size: 0.825rem;
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  letter-spacing: 0.01em;
}

.callback-reason {
  background: var(--bg-surface);
  border: 1px solid var(--border-light);
  border-radius: 4px;
  padding: 0.75rem 1rem;
  font-size: 0.925rem;
  color: var(--text-sub);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.callback-reason.callback-reason-empty {
  background: transparent;
  border: none;
  padding: 0;
  color: var(--text-muted);
  font-style: italic;
}

.mark-handled-form {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.25rem;
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

.handled-label {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
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
  .callback-dashboard {
    padding: 0 1rem;
    margin: 1.5rem auto;
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

export interface RenderDashboardPageOptions {
  staffUser: StaffUser;
  callbacks: CallbackRequestSummary[];
}

function callbackActionHtml(callback: CallbackRequestSummary): string {
  if (callback.status === 'pending') {
    return `<form method="post" action="${STAFF_DASHBOARD_PATH}/callbacks/${escapeHtml(callback.id)}/handled" class="mark-handled-form">
      <button type="submit" class="mark-handled-button">Mark as handled</button>
    </form>`;
  }
  const handledAt = callback.handledAt ? escapeHtml(callback.handledAt.toISOString()) : '';
  return `<span class="handled-label">Handled ${handledAt}</span>`;
}

function callbackRowHtml(callback: CallbackRequestSummary): string {
  const statusClass = callback.status === 'pending' ? 'status-pending' : 'status-handled';
  const reasonHtml = callback.reason
    ? `<p class="callback-reason">${escapeHtml(callback.reason)}</p>`
    : '<p class="callback-reason callback-reason-empty">(no reason given)</p>';

  return `<li class="callback-row ${statusClass}" id="callback-${escapeHtml(callback.id)}">
    <p class="callback-caller">${escapeHtml(callback.callerName)} — ${escapeHtml(callback.callerPhone)}</p>
    <p class="callback-meta">Language: ${escapeHtml(callback.language)} · Received: ${escapeHtml(callback.createdAt.toISOString())}</p>
    ${reasonHtml}
    ${callbackActionHtml(callback)}
  </li>`;
}

export function renderDashboardPage(options: RenderDashboardPageOptions): string {
  const rows = options.callbacks.length
    ? options.callbacks.map(callbackRowHtml).join('\n')
    : '<li class="callback-row-empty">No callback requests yet.</li>';

  return pageShell(
    'Callback requests',
    `<header class="staff-header">
  <h1>Callback requests</h1>
  <form method="post" action="${STAFF_LOGOUT_PATH}" class="logout-form">
    <button type="submit" id="logout-button">Log out</button>
  </form>
</header>
<main class="callback-dashboard">
  <ul class="callback-list" id="callback-list">
    ${rows}
  </ul>
</main>`,
  );
}
