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
 */

export const VAPI_WIDGET_SCRIPT_ORIGIN = 'https://cdn.jsdelivr.net';
const VAPI_WIDGET_SCRIPT_URL = `${VAPI_WIDGET_SCRIPT_ORIGIN}/gh/VapiAI/html-script-tag@latest/dist/assets/index.js`;

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

/** The same-origin bootstrap script served at GET /vapi-test-call.js. */
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
  };
})(document, "script");
`;
}
