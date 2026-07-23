import type { RequestSpec } from "@atp/schema";

import type { AuthProvider, RunContext } from "./context";
import { sendRequest } from "./http";
import { resolveTemplates } from "./variables";

/**
 * Authentication providers (research §10.2/§10.3). A step's `request.authRef` names a
 * provider; `applyAuth` looks it up in the run's registry and lets it inject credentials
 * into the already-template-resolved request. Providers are the reusable building block
 * that lives in `tests/_shared/auth` — `bearer`, `basic`, `api-key`,
 * `oauth2-client-credentials` (token cached per run), and a `custom` escape hatch.
 *
 * After a provider runs, `applyAuth` re-resolves templates in the request so credentials
 * expressed as templates — e.g. `bearerAuth({ token: "{{secrets.API_TOKEN}}" })` —
 * resolve against the run context. Redaction masks the auth header before persistence.
 */

/**
 * Merge headers onto a request without mutating the original. Matching is
 * case-insensitive, so an injected `authorization` replaces a pre-existing
 * `Authorization` rather than sending both (undici would forward a duplicate).
 */
function withHeaders(request: RequestSpec, headers: Record<string, string>): RequestSpec {
  const merged: Record<string, string> = { ...(request.headers ?? {}) };
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === lower) delete merged[existing];
    }
    merged[name] = value;
  }
  return { ...request, headers: merged };
}

/** `Authorization` bearer token. */
export function bearerAuth(opts: { id: string; token: string }): AuthProvider {
  return {
    id: opts.id,
    apply: (request) => withHeaders(request, { authorization: `Bearer ${opts.token}` }),
  };
}

/** HTTP basic auth: `Authorization: Basic base64(user:pass)`. */
export function basicAuth(opts: { id: string; username: string; password: string }): AuthProvider {
  const encoded = Buffer.from(`${opts.username}:${opts.password}`).toString("base64");
  return {
    id: opts.id,
    apply: (request) => withHeaders(request, { authorization: `Basic ${encoded}` }),
  };
}

/** API key passed either as a request header (default) or a query parameter. */
export function apiKeyAuth(opts: {
  id: string;
  name: string;
  value: string;
  in?: "header" | "query";
}): AuthProvider {
  return {
    id: opts.id,
    apply: (request) =>
      opts.in === "query"
        ? { ...request, query: { ...(request.query ?? {}), [opts.name]: opts.value } }
        : withHeaders(request, { [opts.name]: opts.value }),
  };
}

/**
 * OAuth 2.0 client-credentials grant. The access token is fetched once per run and
 * cached in `ctx.authCache` (keyed by provider id), so a suite that authenticates many
 * nodes hits the token endpoint a single time. Concurrent nodes share the in-flight
 * fetch because the *promise* is cached.
 */
export function oauth2ClientCredentials(opts: {
  id: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  scope?: string;
}): AuthProvider {
  return {
    id: opts.id,
    apply: async (request, ctx) => {
      let pending = ctx.authCache.get(opts.id);
      if (!pending) {
        pending = fetchClientCredentialsToken(opts, ctx.signal);
        // Cache only successes: a rejected fetch (transient token-endpoint failure or a
        // cancellation) is evicted so a later node retries instead of reusing the error.
        pending.catch(() => ctx.authCache.delete(opts.id));
        ctx.authCache.set(opts.id, pending);
      }
      const token = await pending;
      return withHeaders(request, { authorization: `Bearer ${token}` });
    },
  };
}

async function fetchClientCredentialsToken(
  opts: { tokenUrl: string; clientId: string; clientSecret: string; scope?: string },
  signal: AbortSignal | undefined,
): Promise<string> {
  const form = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  if (opts.scope) form.set("scope", opts.scope);

  const response = await sendRequest(
    {
      method: "POST",
      url: opts.tokenUrl,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    { signal },
  );
  const token = (response.body as { access_token?: unknown } | null)?.access_token;
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `oauth2 token request to ${opts.tokenUrl} returned no access_token (status ${response.status})`,
    );
  }
  return token;
}

/** Escape hatch: an arbitrary request transform (e.g. request signing). */
export function customAuth(opts: {
  id: string;
  apply: (request: RequestSpec, ctx: RunContext) => RequestSpec | Promise<RequestSpec>;
}): AuthProvider {
  return { id: opts.id, apply: opts.apply };
}

/**
 * Index a list of providers by id into the registry the run context carries. Ids are
 * the `authRef` addressing keys, so a duplicate throws (mirroring `topoSort`/schema
 * `uniqueById`) rather than silently dropping a provider.
 */
export function buildAuthRegistry(
  providers: AuthProvider[] | undefined,
): Record<string, AuthProvider> {
  const registry: Record<string, AuthProvider> = {};
  for (const provider of providers ?? []) {
    if (provider.id in registry) {
      throw new Error(`duplicate auth provider id "${provider.id}"`);
    }
    registry[provider.id] = provider;
  }
  return registry;
}

/**
 * Resolve a request's `authRef` against the run's provider registry and apply it. A
 * request with no `authRef` passes through untouched. An `authRef` with no matching
 * provider throws (an authoring/config error the runner surfaces as an errored step).
 */
export async function applyAuth(request: RequestSpec, ctx: RunContext): Promise<RequestSpec> {
  if (!request.authRef) return request;
  const provider = ctx.auth[request.authRef];
  if (!provider) {
    throw new Error(`unknown authRef "${request.authRef}": no matching auth provider registered`);
  }
  const authed = await provider.apply(request, ctx);
  // Resolve templates the provider injected (e.g. `{{secrets.API_TOKEN}}`).
  return resolveTemplates(authed, ctx);
}
