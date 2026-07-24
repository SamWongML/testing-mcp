import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

/**
 * OAuth 2.1 authn/authz for the MCP surface (research §15, ADR-007). This module is the pure
 * core: bearer-token parsing, the two-scope authorization model, RFC 9728 protected-resource
 * metadata, and JWT verification via `jose`. The HTTP layer (`http.ts`) verifies the token and
 * threads the resulting {@link AuthInfo} into every request; the tool handlers enforce scope.
 *
 * Everything here is deployment-agnostic and side-effect free (no network beyond the JWKS the
 * authenticator is configured with), so it unit-tests without an authorization server.
 */

/** The two authorization scopes (§8.2): read-only catalog/report access vs. invoking runs. */
export const SCOPES = {
  /** Catalog + report reads: `list_tests`, `describe_test`, `get_report`, `list_runs`, resources. */
  READ: "test:read",
  /** Run-invoking calls: `run_test`, `run_suite`, `run_selection`, `cancel_run`. */
  RUN: "test:run",
} as const;

export type Scope = (typeof SCOPES)[keyof typeof SCOPES];

/** The RFC 9728 well-known path the server serves its protected-resource metadata at, and the
 *  target of the `WWW-Authenticate` challenge on a 401. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

/** Extract the token from an `Authorization: Bearer <token>` header, or null if absent/other
 *  scheme. Case-insensitive on the scheme; a scheme with no token is treated as absent. */
export function parseBearerToken(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(\S.*)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/** Thrown when a validated principal lacks the scope a handler requires. Carries the missing
 *  scope so callers can map it to an authorization error; the message is client-facing. */
export class ScopeError extends Error {
  constructor(public readonly requiredScope: string) {
    super(`insufficient scope: this call requires "${requiredScope}"`);
    this.name = "ScopeError";
  }
}

/** Authorize a call: throw {@link ScopeError} unless `granted` includes `required`. */
export function assertScope(granted: string[] | undefined, required: Scope): void {
  if (!granted?.includes(required)) throw new ScopeError(required);
}

/** OAuth access tokens carry scopes in the space-delimited `scope` claim (RFC 8693); tolerate a
 *  non-standard `scopes` array too. */
export function parseScopes(payload: JWTPayload): string[] {
  if (typeof payload.scope === "string") return payload.scope.split(/\s+/).filter(Boolean);
  if (Array.isArray(payload.scopes))
    return payload.scopes.filter((s): s is string => typeof s === "string");
  return [];
}

/** The RFC 9728 protected-resource metadata document: which authorization server issues tokens
 *  for this resource and which scopes it supports. Served at {@link PROTECTED_RESOURCE_PATH}. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: string[];
  scopes_supported: string[];
  bearer_methods_supported: string[];
}

export function protectedResourceMetadata(opts: {
  resource: string;
  issuer: string;
}): ProtectedResourceMetadata {
  return {
    resource: opts.resource,
    authorization_servers: [opts.issuer],
    scopes_supported: [SCOPES.READ, SCOPES.RUN],
    bearer_methods_supported: ["header"],
  };
}

/** The `WWW-Authenticate` challenge for a 401, pointing clients at the metadata doc (RFC 9728
 *  §5.1) so they can discover the authorization server. */
export function wwwAuthenticate(resourceMetadataUrl: string): string {
  return `Bearer resource_metadata="${resourceMetadataUrl}"`;
}

/** Verifies access tokens against a configured key set + issuer + resource, returning the SDK's
 *  {@link AuthInfo}. Built once at boot (`createAuthenticator`) and shared per request. */
export interface Authenticator {
  verify(token: string): Promise<AuthInfo>;
}

export interface AuthenticatorConfig {
  /** Required token `iss`. */
  issuer: string;
  /** This server's RFC 8707 resource identifier — the required token `aud`. */
  resource: string;
  /** The signature key resolver — `createRemoteJWKSet(jwksUri)` in production, a local set in
   *  tests. When omitted, {@link createAuthenticator} builds a remote set from `jwksUri`. */
  keys?: JWTVerifyGetKey;
  /** JWKS endpoint (used when `keys` is not supplied). */
  jwksUri?: string;
}

/**
 * Build an {@link Authenticator}. Token verification enforces the signature (against the JWKS),
 * the issuer, the audience (RFC 8707 — the token must be minted for *this* resource), and
 * expiry; any failure rejects with a `jose` error the HTTP layer turns into a 401.
 */
export function createAuthenticator(config: AuthenticatorConfig): Authenticator {
  const keys = config.keys ?? createRemoteJWKSet(new URL(requireJwks(config.jwksUri)));
  return {
    async verify(token: string): Promise<AuthInfo> {
      const { payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.resource,
      });
      return {
        token,
        clientId: clientIdOf(payload),
        scopes: parseScopes(payload),
        expiresAt: payload.exp,
        resource: new URL(config.resource),
      };
    },
  };
}

function requireJwks(jwksUri: string | undefined): string {
  if (!jwksUri) throw new Error("AUTH_JWKS_URI is required when auth is enabled");
  return jwksUri;
}

/** The invoking principal for audit/attribution: the OAuth client, falling back through the
 *  authorized party and subject. */
function clientIdOf(payload: JWTPayload): string {
  const claim = payload.client_id ?? payload.azp ?? payload.sub;
  return typeof claim === "string" ? claim : "unknown";
}
