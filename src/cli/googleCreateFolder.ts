/**
 * `npm run google:create-folder -- <folder name>` — creates one more private Drive folder with the
 * archive's own OAuth token and prints its folder id (VP-13: the transcript folder).
 *
 * Why a command instead of making the folder by hand in Drive: the archive only holds the narrow
 * `drive.file` permission, so it can see — and upload into — folders THIS app created itself. A
 * folder made in the Drive web UI is invisible to it and every upload fails with "not found".
 * (Sharing it with the service account does not help: Drive uploads use the OAuth token, the
 * service account is for the Sheet only.) The new folder lands in "My Drive"; rename or move it
 * freely afterwards — its id, and the app's access to it, do not change.
 *
 * Needs GOOGLE_OAUTH_CLIENT_ID / _CLIENT_SECRET / _REFRESH_TOKEN in `.env`. Prints no secret.
 */
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

import { refreshTokenProvider } from '../google/auth.js';
import { createDriveClient, type DriveClient } from '../google/drive.js';

const REQUIRED = [
  'GOOGLE_OAUTH_CLIENT_ID',
  'GOOGLE_OAUTH_CLIENT_SECRET',
  'GOOGLE_OAUTH_REFRESH_TOKEN',
] as const;

function print(text: string): void {
  process.stdout.write(`${text}\n`);
}

export interface CreateFolderDeps {
  env?: NodeJS.ProcessEnv;
  /** For tests; defaults to the real Drive client authenticated from `env`. */
  createDrive?: (env: NodeJS.ProcessEnv) => Pick<DriveClient, 'createFolder'>;
}

function realDrive(env: NodeJS.ProcessEnv): Pick<DriveClient, 'createFolder'> {
  return createDriveClient(
    refreshTokenProvider({
      clientId: env.GOOGLE_OAUTH_CLIENT_ID as string,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET as string,
      refreshToken: env.GOOGLE_OAUTH_REFRESH_TOKEN as string,
    }),
  );
}

export async function runCreateFolder(
  argv: string[],
  deps: CreateFolderDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const name = argv.join(' ').trim();
  if (!name) {
    print('Usage: npm run google:create-folder -- <folder name>');
    return 1;
  }
  const missing = REQUIRED.filter((variable) => !env[variable]);
  if (missing.length > 0) {
    print(`Set ${missing.join(', ')} in .env first (docs/VP12-GOOGLE-SETUP.md).`);
    return 1;
  }

  const folderId = await (deps.createDrive ?? realDrive)(env).createFolder(name);
  print(`Created Drive folder "${name}" — folder id: ${folderId}`);
  print('Put that id in .env (and in Vercel) as the folder variable you need, then run:');
  print('  npm run google:check');
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  loadDotenv({ quiet: true });
  runCreateFolder(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Creating the folder failed.'}\n`,
      );
      process.exit(1);
    },
  );
}
