import type { ExecutionResult, StepResult } from "@atp/schema";

import { assertionLine } from "./util";

/**
 * The heuristic "likely cause" classifier (research §14, ADR-006). Given a finished
 * `ExecutionResult`, it names the most probable reason a run did not pass and the next
 * action an agent should take — distinguishing auth (401/403) from a server error (5xx),
 * a timeout, a connection failure, a schema mismatch, and a plain assertion mismatch.
 * This one function backs both the `llm_summary` and the markdown/html failure sections,
 * so the diagnosis never drifts between formats.
 */

export type LikelyCause =
  | "auth"
  | "server-error"
  | "timeout"
  | "network"
  | "schema-mismatch"
  | "assertion-failed"
  | "cancelled"
  | "errored";

export interface Diagnosis {
  cause: LikelyCause;
  /** The step that triggered the diagnosis (absent for a run-level cancel/error). */
  stepId?: string;
  /** One-line human explanation. */
  detail: string;
  /** What to do next. */
  nextAction: string;
}

const NEXT_ACTION: Record<LikelyCause, string> = {
  auth: "Check the request's auth — authRef/token/scopes or the credentials it resolves.",
  "server-error": "The SUT returned 5xx; inspect the service — the test may be correct.",
  timeout: "Increase the step/suite timeoutMs, or check SUT latency and availability.",
  network: "Verify the SUT host/port is reachable (DNS, connectivity, service up).",
  "schema-mismatch": "The response shape changed — update the jsonSchema assertion or fix the SUT.",
  "assertion-failed": "Compare expected vs actual — update the assertion or fix the SUT.",
  cancelled: "The run was cancelled before completing; re-run to get a verdict.",
  errored: "See the step error — likely an authoring or connectivity problem.",
};

const TIMEOUT_RE = /timeout|timed out|abort/i;
const NETWORK_RE = /econn|enotfound|network|fetch failed|socket|dns|getaddr|unreachable/i;

/** Classify free-text error output as a timeout or a connection failure (else undefined). */
function classifyErrorText(text: string | undefined): "timeout" | "network" | undefined {
  if (!text) return undefined;
  if (TIMEOUT_RE.test(text)) return "timeout";
  if (NETWORK_RE.test(text)) return "network";
  return undefined;
}

/** Classify why a run did not pass. Returns `undefined` for a passed run. */
export function diagnose(result: ExecutionResult): Diagnosis | undefined {
  if (result.status === "passed") return undefined;

  // A run-level error string is the most authoritative timeout/network signal: the engine
  // records a whole-suite `timeoutMs` breach as an `errored` run whose in-flight/pending
  // nodes read as `cancelled` (runner.ts), so the per-step scan alone would call it
  // `cancelled`. Classify from `result.error` first so a suite-budget timeout is a timeout.
  const runLevel = classifyErrorText(result.error);

  const step = result.steps.find(
    (s) => s.status === "failed" || s.status === "errored" || s.status === "cancelled",
  );

  // No offending step — a run-level cancel/error (e.g. the whole run timed out before any
  // step recorded a result).
  if (!step) {
    if (runLevel) {
      return { cause: runLevel, detail: result.error as string, nextAction: NEXT_ACTION[runLevel] };
    }
    const cause: LikelyCause = result.status === "cancelled" ? "cancelled" : "errored";
    return { cause, detail: result.error ?? `Run ${result.status}.`, nextAction: NEXT_ACTION[cause] };
  }

  if (step.status === "cancelled") {
    // A node cancelled under a run-level timeout inherits that cause; a plain caller-cancel
    // (no timeout/network signal in `result.error`) stays `cancelled`.
    if (runLevel) return diag(runLevel, step, result.error as string);
    return diag("cancelled", step, result.error ?? `Step "${step.id}" was cancelled.`);
  }

  if (step.status === "errored") {
    const err = step.error ?? "";
    const cause = classifyErrorText(err) ?? "errored";
    return diag(cause, step, err || `Step "${step.id}" errored.`);
  }

  // status === "failed": prefer the response status (most actionable), then assertions.
  const status = step.response?.status;
  if (status === 401 || status === 403) {
    return diag("auth", step, `Request "${step.id}" returned ${status} (authentication/authorization).`);
  }
  if (status !== undefined && status >= 500) {
    return diag("server-error", step, `Request "${step.id}" returned ${status} (server error).`);
  }

  const failed = step.assertions.find((a) => !a.ok);
  if (failed?.op === "jsonSchema") {
    const where = failed.path ? ` at ${failed.path}` : "";
    return diag("schema-mismatch", step, `Step "${step.id}" response failed schema validation${where}.`);
  }
  if (failed) {
    return diag("assertion-failed", step, `Step "${step.id}" ${assertionLine(failed)}.`);
  }

  return diag("assertion-failed", step, `Step "${step.id}" failed.`);
}

function diag(cause: LikelyCause, step: StepResult, detail: string): Diagnosis {
  return { cause, stepId: step.id, detail, nextAction: NEXT_ACTION[cause] };
}
