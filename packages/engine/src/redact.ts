import type { RequestSpec } from "@atp/schema";

import type { EngineResponse, ResolvedRequest } from "./context";
import { mapDeepStrings } from "./util";

/**
 * Secret redaction. Snapshots persisted to the store/S3 pass
 * through here first so tokens and PII never land at rest: sensitive header values
 * are masked wholesale, and any known secret *value* is masked wherever it appears
 * in headers or the (string-walked) body.
 */

const MASK = "***";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
]);

function maskSecrets(input: string, secrets: readonly string[]): string {
  let out = input;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(MASK);
  }
  return out;
}

/**
 * Mask a header/query value that is only *typed* as a string. A whole-value template keeps
 * its source type — `{{params.sleepMs}}` on a numeric param resolves to a number — so the
 * resolved request can carry a non-string here even though `RequestSpec` says otherwise.
 * undici stringifies it on the wire, so the snapshot records the string form; masking the
 * raw value instead used to throw (`out.split is not a function`) and error the whole run
 * from the *persistence* path, which is the last place that should be able to fail a test.
 */
function maskValue(value: unknown, secrets: readonly string[]): string {
  return maskSecrets(typeof value === "string" ? value : String(value), secrets);
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  return mapDeepStrings(value, (s) => maskSecrets(s, secrets));
}

function redactHeaders(
  headers: Record<string, string> | undefined,
  secrets: readonly string[],
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? MASK : maskValue(v, secrets);
  }
  return out;
}

function redactQuery(
  query: Record<string, string> | undefined,
  secrets: readonly string[],
): Record<string, string> | undefined {
  if (!query) return query;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) out[k] = maskValue(v, secrets);
  return out;
}

/** Redact a request snapshot before persistence. */
export function redactRequest(req: ResolvedRequest, secrets: readonly string[]): RequestSpec {
  return {
    ...req,
    headers: redactHeaders(req.headers, secrets),
    query: redactQuery(req.query, secrets),
    body: req.body === undefined ? undefined : redactDeep(req.body, secrets),
  };
}

/** Redact a response snapshot before persistence. */
export function redactResponse(res: EngineResponse, secrets: readonly string[]): EngineResponse {
  return {
    status: res.status,
    headers: redactHeaders(res.headers, secrets) ?? {},
    body: res.body === undefined ? undefined : redactDeep(res.body, secrets),
    timingMs: res.timingMs,
  };
}
