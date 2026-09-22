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
