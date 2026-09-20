/**
 * Renders the manual QA test-call page (work order §6.8). Internal tool
 * only — the static directory these are written to (generateTestPage.ts) is
 * mounted in app.ts only when NODE_ENV !== 'production'.
 *
 * R5 (VAPI-FACTS.md): uses Vapi's hosted script-tag embed — no bundler, no
 * new build tooling, matching "zero new build tooling" over @vapi-ai/web.
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

const VAPI_WIDGET_SCRIPT_URL =
  'https://cdn.jsdelivr.net/gh/VapiAI/html-script-tag@latest/dist/assets/index.js';

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

/** File-name stem shared by the generated page and its bootstrap script. */
export function testCallFileBase(clientId: string, language: string): string {
  return `${clientId}--${language}`;
}

export function renderTestCallPage(options: TestCallPageOptions): string {
  const clientId = escapeHtml(options.clientId);
  const language = escapeHtml(options.language);
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
 * The same-origin bootstrap script written next to the page by generateTestPage.ts.
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
        var vapiInstance = window.vapiSDK.vapi;
        var originalStart = vapiInstance.start.bind(vapiInstance);
        vapiInstance.start = function () {
          console.info('Vapi start() configured values:', JSON.stringify({
            publicKey: ${safeJsonForScript(options.publicKey)},
            assistantId: ${safeJsonForScript(options.assistantId)},
          }));
          console.info('Vapi start() actual arguments:', JSON.stringify(Array.prototype.slice.call(arguments)));
          return originalStart.apply(null, arguments);
        };
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
