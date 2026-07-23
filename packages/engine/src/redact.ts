import type { RequestSpec } from "@atp/schema";

import type { EngineResponse, ResolvedRequest } from "./context";

/**
 * Secret redaction (research §10.2, §21). Snapshots persisted to the store/S3 pass
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

function redactString(value: string, secrets: readonly string[]): string {
  return maskSecrets(value, secrets);
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, secrets);
    return out;
  }
  return value;
}

function redactHeaders(
  headers: Record<string, string> | undefined,
  secrets: readonly string[],
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? MASK : redactString(v, secrets);
  }
  return out;
}

/** Redact a request snapshot before persistence. */
export function redactRequest(req: ResolvedRequest, secrets: readonly string[]): RequestSpec {
  return {
    ...req,
    headers: redactHeaders(req.headers, secrets),
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
