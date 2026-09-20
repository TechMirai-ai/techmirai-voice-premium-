/** Starts the HTTP server. All wiring of env → pool → app happens here. */
import { createApp } from './app.js';
import { createPool } from './db/pool.js';
import { isProduction, loadEnv } from './env.js';
import { logger } from './lib/logger.js';

const env = loadEnv();
const pool = createPool({ connectionString: env.DATABASE_URL });
const app = createApp({
  db: pool,
  isProduction: isProduction(env),
});

const server = app.listen(env.PORT, () => {
  logger.info('server listening', { port: env.PORT, nodeEnv: env.NODE_ENV });
});

function shutdown(signal: string): void {
  logger.info('shutting down', { signal });
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
