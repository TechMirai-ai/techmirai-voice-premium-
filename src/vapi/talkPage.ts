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
  /**
   * Present only on the owner/staff bypass link (`?key=...`, VP-9). Embedded as a
   * page-level global so the bootstrap script can forward it to the call-limit
   * check — the actual bypass is still verified server-side on every call attempt,
   * this is only how the value reaches that request from a page load.
   */
  bypassKey?: string;
}

export function renderTalkPage(options: TalkPageOptions): string {
  const clinicName = escapeHtml(options.clinicName);
  const language = escapeHtml(options.language);
  const scriptSrc = escapeHtml(options.scriptSrc);
  const bypassKeyScript = options.bypassKey
    ? `<script>window.__TALK_BYPASS_KEY__ = ${safeJsonForScript(options.bypassKey)};</script>\n`
    : '';
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
${bypassKeyScript}<script type="module" src="${scriptSrc}"></script>
</body>
</html>
`;
}

export interface TalkBootstrapOptions {
  /** Vapi's public key — safe to expose in the browser (VAPI-FACTS.md, "Public key vs. private key"). */
  publicKey: string;
  /**
   * The gated endpoint checked (server-side, VP-9) before each call attempt —
   * it hands back the real assistant id only if the visitor is still under the
   * call cap or has a valid bypass key, and never otherwise. Unlike the old
   * flow, the assistant id is deliberately NOT embedded in this script: handing
   * it out unconditionally on page load would make the whole cap meaningless.
   */
  callsUrl: string;
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
var callsUrl = ${safeJsonForScript(options.callsUrl)};
var bypassKey = window.__TALK_BYPASS_KEY__;
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

// A real phone call rings before it connects; a browser web call has no such
// delay by default, so this is purely cosmetic realism — a short synthesized
// ringback tone (no audio file to host), played from inside the click handler
// so the AudioContext satisfies browsers' user-gesture requirement. Never
// blocks or fails the real call: any audio error just resolves immediately.
function playRingback() {
  return new Promise(function (resolve) {
    try {
      var AudioContextClass = window.AudioContext || window.webkitAudioContext;
      var ctx = new AudioContextClass();
      var duration = 1.4;
      var now = ctx.currentTime;
      [440, 480].forEach(function (freq) {
        var osc = ctx.createOscillator();
        var gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.05);
        gain.gain.setValueAtTime(0.06, now + duration - 0.05);
        gain.gain.linearRampToValueAtTime(0, now + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + duration);
      });
      setTimeout(function () {
        ctx.close();
        resolve();
      }, duration * 1000);
    } catch (e) {
      resolve();
    }
  });
}

button.addEventListener('click', function () {
  if (inCall) {
    vapi.stop();
    return;
  }
  if (statusEl) statusEl.textContent = 'Calling…';
  var url = callsUrl + (bypassKey ? '?key=' + encodeURIComponent(bypassKey) : '');
  var ringbackDone = playRingback();
  var sessionDone = fetch(url, { method: 'POST', credentials: 'same-origin' })
    .then(function (res) {
      if (res.status === 429) {
        if (statusEl) statusEl.textContent = "You've reached the demo call limit. Please get in touch to try it live.";
        return null;
      }
      if (!res.ok) throw new Error('call session request failed');
      return res.json();
    });
  // Starts as soon as the ringback tone ends AND the call-limit check has come
  // back — whichever finishes last, so a slow network never cuts the ring short.
  Promise.all([ringbackDone, sessionDone])
    .then(function (results) {
      var data = results[1];
      if (!data) return;
      if (statusEl) statusEl.textContent = 'Connecting…';
      vapi.start(data.assistantId, { maxDurationSeconds: data.maxDurationSeconds });
    })
    .catch(function (e) {
      console.error('Call session error:', e);
      if (statusEl) statusEl.textContent = 'Something went wrong — please try again.';
    });
});
`;
}
