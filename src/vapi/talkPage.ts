/**
 * Renders the public, link-shareable "Talk" demo page (production-hosted,
 * mounted unconditionally — unlike testPage.ts's internal-QA-only tool).
 * Shows nothing but the clinic's own (already-public, spoken-on-the-phone)
 * name and a single Talk button: no clientId, no assistant/squad id, no
 * debug console output.
 *
 * Reuses the same pinned-Web-SDK-via-jsDelivr approach as testPage.ts, and
 * needs the same no-CSP route treatment (see app.ts / VAPI-FACTS.md's KNOWN
 * ISSUE) — both are inherent to how Vapi's Web SDK joins a Daily room
 * client-side, not specific to either page's design.
 */
import { escapeHtml } from '../lib/htmlEscape.js';

const VAPI_WEB_SDK_ESM_URL = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.1/+esm';

/** JSON-encodes a value for safe embedding inside a <script> block. */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface TalkSwitchLink {
  /** The other language's own localized clinic name — never a raw language code. */
  label: string;
  href: string;
}

export interface TalkPageOptions {
  /** The clinic's own name in the page's language (client.yaml `business.name`) — never the internal clientId slug. */
  clinicName: string;
  language: string;
  switchLinks: TalkSwitchLink[];
  scriptSrc: string;
}

export function renderTalkPage(options: TalkPageOptions): string {
  const clinicName = escapeHtml(options.clinicName);
  const language = escapeHtml(options.language);
  const scriptSrc = escapeHtml(options.scriptSrc);
  const switcher = options.switchLinks
    .map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.label)}</a>`)
    .join(' · ');

  return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${clinicName}</title>
<style>
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

:root {
  --bg-canvas: #f8f9fa;
  --bg-surface: #ffffff;
  --border-light: #e2e8f0;
  --text-main: #1e293b;
  --text-sub: #475569;
  --brand-navy: #1e293b;
  --brand-navy-hover: #0f172a;
}

html {
  background-color: var(--bg-canvas);
  min-height: 100%;
}

body {
  background-color: var(--bg-surface);
  color: var(--text-main);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Meiryo", sans-serif;
  font-size: 16px;
  line-height: 1.6;
  text-align: center;
  max-width: 420px;
  margin: 5rem auto;
  padding: 2.5rem 2rem;
  border: 1px solid var(--border-light);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.04);
}

h1 {
  font-size: 1.3rem;
  font-weight: 600;
  color: var(--brand-navy);
  margin-bottom: 1.5rem;
}

.switch {
  font-size: 0.85rem;
  margin-bottom: 1.5rem;
}

.switch a {
  color: var(--text-sub);
  text-decoration: underline;
}

#talk-button {
  font-family: inherit;
  font-size: 1.05rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  padding: 0.85rem 2.5rem;
  border-radius: 999px;
  cursor: pointer;
  background: var(--brand-navy);
  color: #ffffff;
  border: 1px solid var(--brand-navy);
  transition: background 0.15s ease;
}

#talk-button:hover {
  background: var(--brand-navy-hover);
}

#call-status {
  margin-top: 1.25rem;
  font-size: 0.85rem;
  color: var(--text-sub);
}

@media (max-width: 480px) {
  body {
    margin: 2rem 1rem;
    padding: 2rem 1.25rem;
  }
}
</style>
</head>
<body>
<h1>${clinicName}</h1>
${switcher ? `<p class="switch">${switcher}</p>` : ''}
<button type="button" id="talk-button">Talk</button>
<p id="call-status" aria-live="polite">Tap to start.</p>
<script type="module" src="${scriptSrc}"></script>
</body>
</html>
`;
}

export interface TalkBootstrapOptions {
  /** Vapi's public key — safe to expose in the browser (VAPI-FACTS.md, "Public key vs. private key"). */
  publicKey: string;
  assistantId: string;
}

/**
 * Same vapi.on('error', ...) requirement as testPage.ts's bootstrap script —
 * without a listener attached before the call starts, a Vapi-emitted error
 * throws a bare, undiagnosable "Unhandled error. (undefined)" (VAPI-FACTS.md).
 * Unlike that internal tool, this never logs the public key or assistant id
 * to the console — nothing here is secret, but there's no reason to spill
 * identifiers into an external client's devtools either.
 */
export function renderTalkBootstrapScript(options: TalkBootstrapOptions): string {
  return `import VapiModule from ${safeJsonForScript(VAPI_WEB_SDK_ESM_URL)};

// jsDelivr's +esm bundler wraps @vapi-ai/web's CJS module.exports as-is, so
// the default import is { __esModule, default: <Vapi class> } (VAPI-FACTS.md).
var Vapi = VapiModule.default || VapiModule;
var vapi = new Vapi(${safeJsonForScript(options.publicKey)});
var button = document.getElementById('talk-button');
var statusEl = document.getElementById('call-status');
var inCall = false;

vapi.on('error', function (e) {
  console.error('Call error:', e);
  if (statusEl) statusEl.textContent = 'Something went wrong — please try again.';
  inCall = false;
  if (button) button.textContent = 'Talk';
});
vapi.on('call-start', function () {
  inCall = true;
  if (statusEl) statusEl.textContent = 'Connected — go ahead and talk.';
  if (button) button.textContent = 'End';
});
vapi.on('call-end', function () {
  inCall = false;
  if (statusEl) statusEl.textContent = 'Call ended. Tap to start again.';
  if (button) button.textContent = 'Talk';
});

button.addEventListener('click', function () {
  if (inCall) {
    vapi.stop();
    return;
  }
  if (statusEl) statusEl.textContent = 'Connecting…';
  vapi.start(${safeJsonForScript(options.assistantId)});
});
`;
}
