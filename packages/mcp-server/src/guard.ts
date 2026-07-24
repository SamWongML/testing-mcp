import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

import { recordAudit } from "@atp/store";

import { assertScope, type Scope } from "./auth";
import type { ServerContext } from "./context";

/**
 * Handler-side authorization + audit (research §15, ADR-007). The HTTP layer validates the
 * token and threads the {@link AuthInfo} into every request's `extra`; these helpers enforce
 * the per-tool scope and record the audit trail. Both no-op gracefully off the auth/db path so
 * the same handlers run unauthenticated in dev/test.
 */

/** The slice of the SDK's handler `extra` these helpers read — the validated token, if any. */
export interface AuthedExtra {
  authInfo?: AuthInfo;
}

/** Enforce `required` on the caller. No-op when auth is disabled (`ctx.authn` absent); otherwise
 *  throws {@link ScopeError} (→ an MCP error result) unless the token carries the scope. */
export function guardScope(ctx: ServerContext, extra: AuthedExtra, required: Scope): void {
  if (!ctx.authn) return;
  assertScope(extra.authInfo?.scopes, required);
}

/** The invoking principal for attribution: the OAuth client id, or `"anonymous"` off-auth. */
export function principalOf(extra: AuthedExtra): string {
  return extra.authInfo?.clientId ?? "anonymous";
}

export interface AuditRunInput {
  action: string;
  entryId?: string;
  params?: Record<string, unknown>;
}

/** Record a run-invoking call in the audit log (§16.1). No-op without a db (the audit log lives
 *  in Postgres); the principal + scopes come from the validated token. */
export async function auditRun(
  ctx: ServerContext,
  extra: AuthedExtra,
  input: AuditRunInput,
): Promise<void> {
  if (!ctx.db) return;
  await recordAudit(ctx.db, {
    principal: principalOf(extra),
    action: input.action,
    entryId: input.entryId,
    params: input.params,
    scopes: extra.authInfo?.scopes,
  });
}
