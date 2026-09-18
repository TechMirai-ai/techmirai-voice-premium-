/**
 * Minimal structured logger. One JSON object per line on stdout/stderr.
 *
 * Every message and every context value is passed through
 * `redactPersonalData` first — see CLAUDE.md: caller names and phone numbers
 * must never be written in plain text.
 *
 * Pass personal data as context, never inside the message string. Phone
 * numbers are caught anywhere, but a NAME is only redacted when it is the
 * value of a known key: `logger.info('saved', { callerName })`, never
 * `logger.info(`saved for ${callerName}`)`. See src/lib/redact.ts.
 */
import { redactPersonalData } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogContext = Record<string, unknown>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

/** Tests stay quiet unless something explicitly asks for output. */
const isTestEnv = (): boolean => process.env.NODE_ENV === 'test';

export interface LogRecord {
  level: LogLevel;
  time: string;
  message: string;
  context?: LogContext;
}

/** Builds the record that would be logged. Exported so tests can assert on it. */
export function buildLogRecord(
  level: LogLevel,
  message: string,
  context?: LogContext,
  now: Date = new Date(),
): LogRecord {
  const redactedContext = context ? (redactPersonalData(context) as LogContext) : undefined;
  return {
    level,
    time: now.toISOString(),
    message: redactPersonalData(message),
    ...(redactedContext ? { context: redactedContext } : {}),
  };
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  if (isTestEnv()) return;
  const line = JSON.stringify(buildLogRecord(level, message, context));
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const logger: Logger = {
  debug: (message, context) => write('debug', message, context),
  info: (message, context) => write('info', message, context),
  warn: (message, context) => write('warn', message, context),
  error: (message, context) => write('error', message, context),
};
