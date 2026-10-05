/**
 * `npm run config:check -- <clientId>`
 *
 * Prints OK plus a short summary, or every problem found with its exact path.
 * Exits non-zero on error so it can be used in CI.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ClientConfigError } from './issues.js';
import { loadClientWithWarnings } from './loadClient.js';
import { SCRIPT_KEYS } from './schema.js';

export function runCheck(clientId: string | undefined): number {
  if (!clientId) {
    console.error('Usage: npm run config:check -- <clientId>');
    return 1;
  }
  
  try {
    const { config, warnings } = loadClientWithWarnings(clientId);

    console.log(`OK  ${clientId}`);
    console.log(`  status:     ${config.status}`);
    console.log(
      `  languages:  ${config.languages.supported.join(', ')} (default: ${config.languages.default})`,
    );
    console.log(`  scripts:    ${SCRIPT_KEYS.length}`);
    console.log(`  FAQ:        ${config.faq.length}`);

    for (const warning of warnings) {
      console.log(`  warning:    ${warning.path}: ${warning.message}`);
    }

    return 0;
  } catch (error) {
    if (error instanceof ClientConfigError) {
      console.error(error.message);
      return 1;
    }
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exitCode = runCheck(process.argv[2]);
}
