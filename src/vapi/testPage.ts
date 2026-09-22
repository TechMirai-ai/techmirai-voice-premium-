/**
 * Renders the manual QA test-call page (work order §6.8). Internal tool
 * only — the static directory these are written to (generateTestPage.ts) is
 * mounted in app.ts only when NODE_ENV !== 'production'.
 *
 * VP-6 R3 (VAPI-FACTS.md): previously used Vapi's hosted script-tag embed
 * (`VapiAI/html-script-tag@latest`), but a real call broke with "daily-js
 * version 0.85.0 is no longer supported" / "Meeting ended due to ejection" —
 * that wrapper bundles a stale, now-rejected Daily SDK version and is not
 * kept in sync with the real @vapi-ai/web package. Switched to importing
 * @vapi-ai/web directly via jsDelivr's `+esm` auto-bundle (pinned version —
 * jsDelivr bundles the npm package on its CDN, so this is still zero new
 * build tooling in this repo, just a different, actively-maintained source).
 *
 * The bootstrap script is served as its own same-origin file
 * (public/vapi-test-call/<clientId>--<language>.js, written by
 * generateTestPage.ts) rather than inlined into the HTML.
 *
 * No Content-Security-Policy is applied to this page — a deliberate decision
 * (see app.ts and docs/VAPI-FACTS.md, "KNOWN ISSUE"): a CSP on the page broke
 * the Daily web-call join, and this is an internal QA-only page. The hosts
 * the widget and Daily contact are recorded in VAPI-FACTS.md in case a CSP is
 * ever reinstated.
 */
import { escapeHtml } from '../lib/htmlEscape.js';

/**
 * Pinned, not `@latest`: the whole reason this file changed (VP-6 R3) is an
 * unpinned upstream wrapper silently going stale. jsDelivr bundles this npm
 * package's actual dependency tree fresh, so bump this deliberately (and
 * re-verify with a real call) rather than floating it.
 */
const VAPI_WEB_SDK_ESM_URL = 'https://cdn.jsdelivr.net/npm/@vapi-ai/web@2.7.1/+esm';

/** JSON-encodes a value for safe embedding inside a <script> block. */
function safeJsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export interface TestCallPageOptions {
  clientId: string;
  /** Omit to describe the squad page (the default target since VP-3). */
  language?: string;
}

/**
 * File-name stem shared by the generated page and its bootstrap script.
 * `<clientId>--squad` for the squad page, `<clientId>--<language>` for a
 * single assistant (the isolation fallback).
 */
export function testCallFileBase(clientId: string, language?: string): string {
  return `${clientId}--${language ?? 'squad'}`;
}

export function renderTestCallPage(options: TestCallPageOptions): string {
  const clientId = escapeHtml(options.clientId);
  const target = options.language
    ? `Assistant language: <code>${escapeHtml(options.language)}</code>`
    : 'Target: <strong>squad</strong> (say "English" / "Japanese" to test the handoff)';
  const scriptSrc = escapeHtml(
    `/vapi-test-call/${testCallFileBase(options.clientId, options.language)}.js`,
  );

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Vapi test call</title>
</head>
<body>
<h1>Manual Vapi test call — internal QA only</h1>
<p>Client: <code>${clientId}</code> — ${target}</p>
<button type="button" id="start-call-button">Start call</button>
<button type="button" id="end-call-button">End call</button>
<p id="call-status">Not started.</p>
<script type="module" src="${scriptSrc}"></script>
</body>
</html>
`;
}

interface TestCallBootstrapBase {
  /** Vapi's public key — safe to expose in the browser (VAPI-FACTS.md). */
  publicKey: string;
}

/** Start a call against one assistant, or (`squadId`) against a squad — VAPI-FACTS.md, VP-3 R4. */
export type TestCallBootstrapOptions = TestCallBootstrapBase &
  ({ assistantId: string; squadId?: never } | { squadId: string; assistantId?: never });

/**
 * The same-origin bootstrap script written next to the page by generateTestPage.ts.
 *
 * Attaches vapi.on('error', ...) before any call starts — without this, an
 * 'error' emitted with no listener attached throws a bare "Unhandled error.
 * (undefined)" (observed 2026-09-20, real test call), which names neither
 * the error's shape nor its message. console.error(e) alone isn't enough
 * either: a real Error instance's message/stack are non-enumerable, so plain
 * JSON.stringify(e) silently drops them — the explicit
 * Object.getOwnPropertyNames(e) replacer includes them regardless of whether
 * Vapi's SDK hands back a plain object (as observed in VAPI-FACTS.md's R7b
 * throwaway testing) or a real Error.
 */
export function renderTestCallBootstrapScript(options: TestCallBootstrapOptions): string {
  // vapi.start(assistant?, assistantOverrides?, squad?, ...) — squad is the
  // third positional argument (VAPI-FACTS.md, VP-3 R4).
  const startArgs = options.squadId
    ? `undefined, undefined, ${safeJsonForScript(options.squadId)}`
    : safeJsonForScript(options.assistantId);
  const configuredLogKey = options.squadId ? 'squadId' : 'assistantId';
  const configuredLogId = options.squadId ?? options.assistantId;

  return `import VapiModule from ${safeJsonForScript(VAPI_WEB_SDK_ESM_URL)};

// jsDelivr's +esm bundler wraps @vapi-ai/web's CJS module.exports as-is, so
// the default import is { __esModule, default: <Vapi class> }, not the class
// itself — confirmed live in a real browser (VAPI-FACTS.md VP-6 R4): a plain
// "import Vapi from ..." throws "Vapi is not a constructor". Unwrap it here,
// falling back to the bare import if jsDelivr's bundling ever changes.
var Vapi = VapiModule.default || VapiModule;
var vapi = new Vapi(${safeJsonForScript(options.publicKey)});
var statusEl = document.getElementById('call-status');

vapi.on('error', function (e) {
  console.error('Vapi call error (raw):', e);
  try {
    console.error(
      'Vapi call error (JSON):',
      JSON.stringify(e, Object.getOwnPropertyNames(e || {})),
    );
  } catch (jsonError) {
    console.error('Vapi call error could not be JSON-stringified:', jsonError);
  }
  if (statusEl) statusEl.textContent = 'Error — see console.';
});
vapi.on('call-start', function () {
  if (statusEl) statusEl.textContent = 'Call in progress.';
});
vapi.on('call-end', function () {
  if (statusEl) statusEl.textContent = 'Call ended.';
});

var originalStart = vapi.start.bind(vapi);
vapi.start = function () {
  console.info('Vapi start() configured values:', JSON.stringify({
    publicKey: ${safeJsonForScript(options.publicKey)},
    ${configuredLogKey}: ${safeJsonForScript(configuredLogId)},
  }));
  console.info('Vapi start() actual arguments:', JSON.stringify(Array.prototype.slice.call(arguments)));
  return originalStart.apply(null, arguments);
};

document.getElementById('start-call-button').addEventListener('click', function () {
  vapi.start(${startArgs});
});
document.getElementById('end-call-button').addEventListener('click', function () {
  vapi.stop();
});
`;
}
