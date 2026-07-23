import { request } from "undici";

import type { EngineResponse, ResolvedRequest } from "./context";

/**
 * undici-based HTTP client (research §4.2, §10.3). Captures timing, enforces a
 * per-step timeout, and threads an `AbortSignal` for cooperative cancellation. Uses
 * undici's global dispatcher so tests intercept with `MockAgent` — no live network.
 *
 * Redirect policy and connection pooling are dispatcher-level concerns in undici v7
 * (the `redirect` interceptor / a `Pool`); they attach to a real dispatcher when one
 * is introduced, and are intentionally not per-request options here.
 */

export interface SendOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

function buildUrl(url: string, query: Record<string, string> | undefined): string {
  if (!query || Object.keys(query).length === 0) return url;
  const u = new URL(url);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === name);
}

function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

function parseBody(text: string, contentType: string | undefined): unknown {
  if (text.length === 0) return undefined;
  if (contentType?.includes("application/json") || contentType?.includes("+json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function combineSignals(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (signal) signals.push(signal);
  if (timeoutMs && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));
  if (signals.length === 0) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/** Send a resolved request and return a normalized response snapshot with timing. */
export async function sendRequest(
  req: ResolvedRequest,
  opts: SendOptions = {},
): Promise<EngineResponse> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") {
      body = req.body;
    } else {
      body = JSON.stringify(req.body);
      if (!hasHeader(headers, "content-type")) headers["content-type"] = "application/json";
    }
  }

  const started = performance.now();
  const res = await request(buildUrl(req.url, req.query), {
    method: req.method,
    headers,
    body,
    signal: combineSignals(opts.signal, opts.timeoutMs),
  });
  const text = await res.body.text();
  const timingMs = performance.now() - started;
  const responseHeaders = normalizeHeaders(res.headers);

  return {
    status: res.statusCode,
    headers: responseHeaders,
    body: parseBody(text, responseHeaders["content-type"]),
    timingMs,
  };
}
