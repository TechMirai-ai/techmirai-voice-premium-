/**
 * Assembles the developer archive from the environment (VP-12). One factory shared by `server.ts`,
 * the Vercel entry `api/index.ts` and `npm run archive:retry`, so the wiring exists — and is tested —
 * exactly once.
 *
 * Returns `undefined` when no Google variable is set, so deploying before the Google setup is done
 * changes nothing; throws (naming the missing variables) when it is only partly configured.
 */
import { loadClient } from '../config/loadClient.js';
import type { ClientConfig } from '../config/schema.js';
import type { Queryable } from '../db/pool.js';
import { PgArchiveJobRepository } from '../repositories/archiveJobRepository.js';
import type { ArchiveRetryRouteDeps } from '../routes/archiveRetry.js';
import type { ReportArchiver } from '../routes/endOfCallReport.js';
import { refreshTokenProvider, serviceAccountProvider } from './auth.js';
import { ArchiveService } from './archiveService.js';
import { loadGoogleArchiveConfig } from './config.js';
import { createDriveClient } from './drive.js';
import { createSheetsClient } from './sheets.js';

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

/** Each client's `business.hours.timezone`, read from its client.yaml once and remembered. */
function clinicTimeZones(load: (clientId: string) => ClientConfig): (clientId: string) => string {
  const cache = new Map<string, string>();
  return (clientId) => {
    const cached = cache.get(clientId);
    if (cached) return cached;
    const timeZone = load(clientId).business.hours.timezone;
    cache.set(clientId, timeZone);
    return timeZone;
  };
}

export interface CreateArchiveOptions {
  /** For tests; defaults to reading `clients/<id>/client.yaml`. */
  loadClientConfig?: (clientId: string) => ClientConfig;
  source?: NodeJS.ProcessEnv;
  db: Queryable;
  vapiApiKey: string;
}

export interface Archive {
  service: ArchiveService;
  /** For the end-of-call-report route. */
  reportArchiver: ReportArchiver;
  /** For the retry endpoint. */
  retry: ArchiveRetryRouteDeps;
}

export function createArchive(options: CreateArchiveOptions): Archive | undefined {
  const config = loadGoogleArchiveConfig(options.source ?? process.env);
  if (!config) return undefined;

  const drive = createDriveClient(refreshTokenProvider(config.oauth));
  const sheets = createSheetsClient(
    serviceAccountProvider({
      clientEmail: config.serviceAccount.clientEmail,
      privateKey: config.serviceAccount.privateKey,
      scopes: [SHEETS_SCOPE],
    }),
    config.sheetId,
  );

  const service = new ArchiveService({
    jobs: new PgArchiveJobRepository(options.db),
    sheets,
    drive,
    audioFolderId: config.audioFolderId,
    transcriptFolderId: config.transcriptFolderId,
    timeZoneFor: clinicTimeZones(options.loadClientConfig ?? loadClient),
    vapi: { apiKey: options.vapiApiKey },
  });

  return {
    service,
    reportArchiver: service,
    retry: { retrySecret: config.retrySecret, service },
  };
}
