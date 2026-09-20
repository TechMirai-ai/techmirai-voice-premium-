/**
 * `npm run vapi:test-page -- <clientId> --language <code>`
 *
 * Bakes the manual test-call page (HTML + bootstrap JS) into plain static
 * files under public/vapi-test-call/, with the synced assistant id and
 * Vapi's public key written directly into the text. app.ts serves that
 * directory with express.static() — no per-request rendering. Re-run after
 * every `vapi:sync --apply`, since the assistant id can change.
 *
 * The output contains the (browser-safe) public key and the assistant id, so
 * public/vapi-test-call/ is git-ignored, never committed.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultClientsDir } from '../config/loadClient.js';
import { LANGUAGE_CODE_PATTERN, SLUG_PATTERN } from '../config/schema.js';
import { loadEnv } from '../env.js';
import { readState } from './stateStore.js';
import { renderTestCallBootstrapScript, renderTestCallPage, testCallFileBase } from './testPage.js';

/** URL prefix app.ts mounts the generated directory under. */
export const TEST_PAGE_URL_PREFIX = '/vapi-test-call';

export function defaultTestPageDir(repoRoot: string = path.dirname(defaultClientsDir())): string {
  return path.join(repoRoot, 'public', 'vapi-test-call');
}

export interface GenerateTestPageOptions {
  clientId: string;
  language: string;
  /** Vapi's public key — safe for the browser (VAPI-FACTS.md). */
  publicKey: string;
  /** Overrides for tests: where the state file / output dir are resolved from. */
  repoRoot?: string;
  outDir?: string;
}

export interface GeneratedTestPage {
  htmlPath: string;
  scriptPath: string;
  /** Path to open in the browser once the app is running. */
  urlPath: string;
}

export function generateTestPage(options: GenerateTestPageOptions): GeneratedTestPage {
  const { clientId, language, publicKey } = options;

  // The ids become file names — reject anything that could escape outDir.
  if (!SLUG_PATTERN.test(clientId) || !LANGUAGE_CODE_PATTERN.test(language)) {
    throw new Error(`Invalid clientId/language: "${clientId}" / "${language}"`);
  }

  const state = readState(clientId, options.repoRoot ? { repoRoot: options.repoRoot } : {});
  const assistantId = state.assistants[`${clientId}--${language}`];
  if (!assistantId) {
    throw new Error(
      `No synced assistant found for "${clientId}" / "${language}". ` +
        `Run: npm run vapi:sync -- ${clientId} --language ${language} --apply`,
    );
  }

  const outDir = options.outDir ?? defaultTestPageDir(options.repoRoot);
  const base = testCallFileBase(clientId, language);
  const htmlPath = path.join(outDir, `${base}.html`);
  const scriptPath = path.join(outDir, `${base}.js`);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(htmlPath, renderTestCallPage({ clientId, language }), 'utf8');
  writeFileSync(scriptPath, renderTestCallBootstrapScript({ publicKey, assistantId }), 'utf8');

  return { htmlPath, scriptPath, urlPath: `${TEST_PAGE_URL_PREFIX}/${base}.html` };
}

// CLI entry point: writes to the streams directly (same reason as cli.ts).
function printLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

function printError(text: string): void {
  process.stderr.write(`${text}\n`);
}

export function runGenerateTestPage(argv: string[]): number {
  const languageFlag = argv.indexOf('--language');
  const language = languageFlag === -1 ? undefined : argv[languageFlag + 1];
  const clientId = argv.find((arg, index) => !arg.startsWith('--') && index !== languageFlag + 1);

  if (!clientId || !language || language.startsWith('--')) {
    printError('Usage: npm run vapi:test-page -- <clientId> --language <code>');
    return 1;
  }

  try {
    const env = loadEnv();
    const result = generateTestPage({ clientId, language, publicKey: env.VAPI_PUBLIC_KEY });
    printLine(`Wrote ${result.htmlPath}`);
    printLine(`Wrote ${result.scriptPath}`);
    // 127.0.0.1, not localhost: the page failed to join a Vapi web call when
    // opened via localhost (docs/VAPI-FACTS.md, KNOWN ISSUE, step 15).
    printLine(`Open: http://127.0.0.1:${env.PORT}${result.urlPath}`);
    return 0;
  } catch (error) {
    printError(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = runGenerateTestPage(process.argv.slice(2));
}
