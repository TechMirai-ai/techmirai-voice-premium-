/**
 * Renders the manual QA test-call page (work order §6.8). Internal tool
 * only — the routes that serve this are gated behind NODE_ENV !== 'production'
 * in app.ts, never mounted in production.
 *
 * R5 (VAPI-FACTS.md): uses Vapi's hosted script-tag embed — no bundler, no
 * new build tooling, matching "zero new build tooling" over @vapi-ai/web.
 *
 * The bootstrap script is served as its own same-origin file
 * (GET /vapi-test-call.js in app.ts) rather than inlined into the HTML.
 * helmet's default Content-Security-Policy is `script-src 'self'` with no
 * `'unsafe-inline'`, which silently blocks an inline <script> — serving this
 * as a same-origin <script src> avoids that without weakening CSP elsewhere.
 * app.ts additionally widens script-src on just this HTML route to allow
 * VAPI_WIDGET_SCRIPT_ORIGIN, since the widget itself loads from that CDN.
 *
 * The widget bundle also fetches its button icon (phone / loader / phone-off
 * states) from VAPI_WIDGET_ICON_ORIGIN at runtime — helmet's default img-src
 * is `'self' data:`, which blocks that fetch, so app.ts widens img-src on
 * this route too. (Its icon font is unaffected: helmet's default font-src
 * includes the broad `https:` scheme already.)
 *
 * Placing the actual call needs `connect-src`/`script-src`/`worker-src`
 * widened further, empirically confirmed against a real call attempt
 * (2026-09-20) and cross-checked against Daily's own CSP guide — Vapi's web
 * calls run on Daily's WebRTC transport (`daily-js`, "call object" mode, no
 * `avoidEval`/Krisp/virtual-background usage here, so this is Daily's
 * documented minimal set, not their Prebuilt/full set):
 * https://docs.daily.co/docs/guides/privacy-and-security/content-security-policy
 * - `script-src`: the observed failure ("Failed to load call object bundle")
 *   was a script-src block on `c.daily.co`, so DAILY_CALL_ORIGINS is added
 *   there (Daily's `avoidEval`-style fallback-domain approach) rather than
 *   adding `'unsafe-eval'`.
 * - `connect-src`: VAPI_API_ORIGIN (the `POST /call/web` Vapi makes to start
 *   a call) plus DAILY_CALL_ORIGINS (Daily's REST fallback domains) and
 *   DAILY_CALL_WSS_ORIGINS (Daily's signaling websockets).
 * - `worker-src`: Daily's guide lists `'self' blob:` for call-object mode
 *   generally, not just for Krisp noise cancellation.
 * Not included (not used by this project): Banuba (`*.banuba.cloud`,
 * virtual backgrounds/blur — audio-only here).
 *
 * DAILY_SENTRY_ORIGIN (2026-09-20 audit): grepped the real `@vapi-ai/web`
 * (npm) and `@daily-co/daily-js@0.87.0` (npm, `client.ts`'s actual runtime
 * dependency) packages, plus the live CDN bundle this page loads, for every
 * hardcoded http(s)/wss URL literal — done in one pass specifically to avoid
 * finding each missing host by spending money on a failed real call. Only
 * one gap turned up beyond what's already listed here: Daily's bundle
 * hardcodes an error-telemetry beacon to its own Sentry project
 * (`o77906.ingest.sentry.io`); pinned as a wildcard subdomain rather than
 * that exact project id, since a daily-js upgrade could rotate it. Every
 * other literal found (`c.daily.co`, `gs.daily.co`, `www.daily.co`,
 * `api.vapi.ai`, `unpkg.com`) was already covered above; `github.com` was
 * just a bundled license comment, not a real connection.
 */

export const VAPI_WIDGET_SCRIPT_ORIGIN = 'https://cdn.jsdelivr.net';
const VAPI_WIDGET_SCRIPT_URL = `${VAPI_WIDGET_SCRIPT_ORIGIN}/gh/VapiAI/html-script-tag@latest/dist/assets/index.js`;
export const VAPI_WIDGET_ICON_ORIGIN = 'https://unpkg.com';
export const VAPI_API_ORIGIN = 'https://api.vapi.ai';
/** Daily's own domain plus its two documented fallback domains — every entry needs all three (see the CSP guide linked above). */
export const DAILY_CALL_ORIGINS = [
  'https://*.daily.co',
  'https://*.dailywebrtc.com',
  'https://*.dailywebrtc.net',
];
/** Daily's hardcoded error-telemetry beacon — see the 2026-09-20 audit note above. */
export const DAILY_SENTRY_ORIGIN = 'https://*.ingest.sentry.io';
export const DAILY_CALL_WSS_ORIGINS = [
  'wss://*.daily.co',
  'wss://*.dailywebrtc.com',
  'wss://*.dailywebrtc.net',
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON-encodes a value for safe embedding inside a <script> block. */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface TestCallPageOptions {
  clientId: string;
  language: string;
}

export function renderTestCallPage(options: TestCallPageOptions): string {
  const clientId = escapeHtml(options.clientId);
  const language = escapeHtml(options.language);
  const scriptQuery = new URLSearchParams({
    clientId: options.clientId,
    language: options.language,
  });
  const scriptSrc = escapeHtml(`/vapi-test-call.js?${scriptQuery.toString()}`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Vapi test call</title>
</head>
<body>
<h1>Manual Vapi test call — internal QA only</h1>
<p>Client: <code>${clientId}</code> — Language: <code>${language}</code></p>
<p>Click the microphone widget in the corner of the page to start a call.</p>
<script src="${scriptSrc}"></script>
</body>
</html>
`;
}

export interface TestCallBootstrapOptions {
  /** Vapi's public key — safe to expose in the browser (VAPI-FACTS.md). */
  publicKey: string;
  assistantId: string;
}

/**
 * The same-origin bootstrap script served at GET /vapi-test-call.js.
 *
 * Attaches vapi.on('error', ...) once the underlying instance
 * (window.vapiSDK.vapi) is available — without this, an 'error' emitted
 * with no listener attached throws a bare "Unhandled error. (undefined)"
 * (observed 2026-09-20, real test call), which names neither the error's
 * shape nor its message. console.error(e) alone isn't enough either: a real
 * Error instance's message/stack are non-enumerable, so plain
 * JSON.stringify(e) silently drops them — the explicit Object.getOwnPropertyNames(e)
 * replacer includes them regardless of whether Vapi's SDK hands back a
 * plain object (as observed in VAPI-FACTS.md's R7b throwaway testing) or a
 * real Error.
 */
export function renderTestCallBootstrapScript(options: TestCallBootstrapOptions): string {
  return `(function (d, t) {
  var g = d.createElement(t), s = d.getElementsByTagName(t)[0];
  g.src = ${safeJsonForScript(VAPI_WIDGET_SCRIPT_URL)};
  g.defer = true;
  g.async = true;
  s.parentNode.insertBefore(g, s);
  g.onload = function () {
    window.vapiSDK.run({
      apiKey: ${safeJsonForScript(options.publicKey)},
      assistant: ${safeJsonForScript(options.assistantId)},
      config: {},
    });
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      if (window.vapiSDK.vapi) {
        clearInterval(iv);
        window.vapiSDK.vapi.on('error', function (e) {
          console.error('Vapi call error (raw):', e);
          try {
            console.error(
              'Vapi call error (JSON):',
              JSON.stringify(e, Object.getOwnPropertyNames(e || {})),
            );
          } catch (jsonError) {
            console.error('Vapi call error could not be JSON-stringified:', jsonError);
          }
        });
      } else if (tries > 100) {
        clearInterval(iv);
        console.error('Vapi call error handler not attached: window.vapiSDK.vapi never appeared');
      }
    }, 100);
  };
})(document, "script");
`;
}
