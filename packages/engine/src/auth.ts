import type { AuthProviderSpec, RequestSpec } from "@atp/schema";

import type { AuthProvider, RunContext } from "./context";
import { sendRequest } from "./http";
import { resolveTemplates } from "./variables";

/**
 * Authentication providers. A step's `request.authRef` names a provider by id;
 * `applyAuth` looks it up in the run's registry and lets it inject credentials into the
 * already-template-resolved request.
 *
 * Providers are **built from declarations** ({@link AuthProviderSpec}) rather than authored as
 * functions, so an entry's providers travel in the manifest and the engine needs no access to
 * authored source to authenticate a run.
 *
 * After a provider runs, `applyAuth` re-resolves templates in the request so credentials
 * expressed as templates — e.g. `{ type: "bearer", token: "{{secrets.API_TOKEN}}" }` —
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
function bearerAuth(opts: { id: string; token: string }): AuthProvider {
  return {
    id: opts.id,
    apply: (request) => withHeaders(request, { authorization: `Bearer ${opts.token}` }),
  };
}

/**
 * HTTP basic auth: `Authorization: Basic base64(user:pass)`.
 *
 * The credentials are resolved against the run context *here*, not by the re-resolve pass
 * `applyAuth` runs over the returned request: base64 encoding happens inside this provider,
 * so a `{{secrets.*}}` password left as a template would be encoded verbatim and reach the
 * SUT as the literal template text — an unauthenticated request that looks authenticated.
 */
function basicAuth(opts: { id: string; username: string; password: string }): AuthProvider {
  return {
    id: opts.id,
    apply: (request, ctx) => {
      const { username, password } = resolveTemplates(
        { username: opts.username, password: opts.password },
        ctx,
      );
      const encoded = Buffer.from(`${username}:${password}`).toString("base64");
      return withHeaders(request, { authorization: `Basic ${encoded}` });
    },
  };
}

/** API key passed either as a request header (default) or a query parameter. */
function apiKeyAuth(opts: {
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
function oauth2ClientCredentials(opts: {
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
        // Same reason as `basicAuth`: the grant fields are consumed by the *token* request,
        // never injected into `request`, so nothing downstream would resolve them.
        pending = fetchClientCredentialsToken(resolveTemplates(opts, ctx), ctx.signal);
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

/** Build the executable provider for one declaration. The `default` arm is reachable only
 * from an unvalidated spec (the Zod union rejects an unknown type), and throws rather than
 * returning a no-op provider that would send the request unauthenticated. */
export function buildAuthProvider(spec: AuthProviderSpec): AuthProvider {
  switch (spec.type) {
    case "bearer":
      return bearerAuth(spec);
    case "basic":
      return basicAuth(spec);
    case "apiKey":
      return apiKeyAuth(spec);
    case "oauth2ClientCredentials":
      return oauth2ClientCredentials(spec);
    default:
      throw new Error(
        `unknown auth provider type "${(spec as { type: string }).type}" for id "${(spec as { id: string }).id}"`,
      );
  }
}

/**
 * Build the registry the run context carries, keyed by id. Ids are the `authRef` addressing
 * keys, so a duplicate throws (mirroring `topoSort`/schema `uniqueById`) rather than silently
 * dropping a provider.
 */
export function buildAuthRegistry(
  specs: AuthProviderSpec[] | undefined,
): Record<string, AuthProvider> {
  const registry: Record<string, AuthProvider> = {};
  for (const spec of specs ?? []) {
    if (spec.id in registry) {
      throw new Error(`duplicate auth provider id "${spec.id}"`);
    }
    registry[spec.id] = buildAuthProvider(spec);
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
