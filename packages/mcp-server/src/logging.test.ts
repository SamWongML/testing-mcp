import { describe, expect, it } from "vitest";

import { createLogger } from "./logging";

/** Capture pino's newline-delimited JSON output as parsed objects. */
function captureLogger(level = "info") {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger(
    { level },
    { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) },
  );
  return { logger, lines };
}

/**
 * Structured logging: every line is JSON, correlation ids thread through child
 * loggers, and secret-shaped fields never reach the log (redaction before persist).
 */
describe("createLogger", () => {
  it("emits structured JSON carrying the message and level", () => {
    const { logger, lines } = captureLogger();
    logger.info({ event: "claimed" }, "job claimed");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ event: "claimed", msg: "job claimed" });
    expect(lines[0]!.level).toBeDefined();
  });

  it("threads correlation ids through a child logger", () => {
    const { logger, lines } = captureLogger();
    const child = logger.child({
      runId: "run-9",
      taskId: "run-9",
      traceId: "trace-1",
      nodeId: "login",
    });
    child.info("running node");
    expect(lines[0]).toMatchObject({
      runId: "run-9",
      taskId: "run-9",
      traceId: "trace-1",
      nodeId: "login",
      msg: "running node",
    });
  });

  it("redacts secret-shaped fields at top level and nested", () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        runId: "run-1",
        token: "super-secret",
        authorization: "Bearer abc.def",
        req: { headers: { authorization: "Bearer xyz" } },
        secrets: { API_KEY: "k-123" },
        auth: { token: "nested-secret" },
      },
      "invoked",
    );
    const out = JSON.stringify(lines[0]);
    expect(lines[0]!.runId).toBe("run-1"); // non-secret retained
    expect(out).not.toContain("super-secret");
    expect(out).not.toContain("Bearer abc.def");
    expect(out).not.toContain("Bearer xyz");
    expect(out).not.toContain("k-123");
    expect(out).not.toContain("nested-secret");
    expect(out).toContain("[REDACTED]");
  });

  it("honors the configured level (debug suppressed at info)", () => {
    const { logger, lines } = captureLogger("info");
    logger.debug("noisy");
    expect(lines).toHaveLength(0);
  });
});
