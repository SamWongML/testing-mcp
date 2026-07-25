import pino, { type DestinationStream, type Logger } from "pino";

/**
 * Structured logging (research §15). One Pino JSON logger per process; correlation ids
 * (`runId`/`taskId`/`traceId`/`nodeId`) are attached via `logger.child({...})` at the point a
 * run/request/node is entered, so every downstream line carries them. Secret-shaped fields are
 * redacted before they can reach stdout (§21 "redact before persist" applied to logs).
 */

export type { Logger } from "pino";

/** Correlation ids threaded through the async run lifecycle; bound onto a child logger. */
export interface CorrelationIds {
  runId?: string;
  taskId?: string;
  traceId?: string;
  nodeId?: string;
}

/** Field paths scrubbed from every log line. Covers auth headers, bearer tokens, and the
 *  engine's `secrets` bag at the top level and one level of nesting (pino `*` is single-level). */
export const REDACT_PATHS = [
  "authorization",
  "token",
  "password",
  "secret",
  "secrets",
  "*.authorization",
  "*.token",
  "*.password",
  "*.secret",
  "headers.authorization",
  "req.headers.authorization",
  "request.headers.authorization",
];

export interface LoggerOptions {
  /** Minimum level to emit (from config `LOG_LEVEL`). */
  level?: string;
  /** Bindings attached to every line (e.g. `{ service, mode }`). */
  base?: Record<string, unknown>;
}

/**
 * Build the process logger. `destination` lets tests capture output; in production pino
 * defaults to stdout (the ECS `awslogs` driver ships it to CloudWatch, §15).
 */
export function createLogger(opts: LoggerOptions = {}, destination?: DestinationStream): Logger {
  return pino(
    {
      level: opts.level ?? "info",
      base: opts.base ?? {},
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    },
    destination,
  );
}
