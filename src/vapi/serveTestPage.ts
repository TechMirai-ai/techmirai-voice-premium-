/**
 * `npm run vapi:test-page:serve [-- --port <n>]`
 *
 * Standalone static server for the generated test-call page — plain
 * node:http, no Express, no helmet, no CSP header — serving
 * public/vapi-test-call/ (written by `npm run vapi:test-page`).
 *
 * Why this exists: while web calls from the main Express app's copy of the
 * page failed to join the Daily room (cause then unknown), the same page from
 * a bare node:http server joined. The main app now joins too when opened at
 * http://127.0.0.1:3000 (docs/VAPI-FACTS.md, "KNOWN ISSUE", step 15), so this
 * is a secondary fallback for when the main app isn't running. Internal QA
 * tool, bound to localhost only.
 */
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TEST_PAGE_URL_PREFIX, defaultTestPageDir } from './generateTestPage.js';

export const DEFAULT_TEST_PAGE_PORT = 3001;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

/** Only the flat file names generateTestPage writes — nothing that can traverse. */
const SERVABLE_FILE = /^[a-z0-9][a-z0-9-]*\.(html|js)$/;

export function createTestPageServer(dir: string = defaultTestPageDir()): Server {
  return createServer((req, res) => {
    const respond = (status: number, body: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(body);
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      respond(405, 'Method not allowed');
      return;
    }

    const pathname = (req.url ?? '').split('?')[0] ?? '';
    const prefix = `${TEST_PAGE_URL_PREFIX}/`;
    const fileName = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : '';
    const filePath = path.join(dir, fileName);

    if (!SERVABLE_FILE.test(fileName) || !existsSync(filePath)) {
      respond(
        404,
        'Not found — generate it with: npm run vapi:test-page -- <clientId> [--language <code>]',
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(fileName)] ?? 'text/plain' });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  });
}

function parsePort(argv: string[]): number {
  const flag = argv.indexOf('--port');
  const value = flag === -1 ? undefined : Number(argv[flag + 1]);
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_TEST_PAGE_PORT;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const port = parsePort(process.argv.slice(2));
  createTestPageServer().listen(port, '127.0.0.1', () => {
    process.stdout.write(
      `Serving ${defaultTestPageDir()} at ` +
        `http://127.0.0.1:${port}${TEST_PAGE_URL_PREFIX}/<clientId>--squad.html (or --<language>.html)\n`,
    );
  });
}
