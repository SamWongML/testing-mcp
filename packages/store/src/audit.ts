import { and, desc, eq } from "drizzle-orm";

import type { Db } from "./db/client";
import { auditLog } from "./db/schema";

/**
 * Audit log — the durable record of who invoked which run, with which
 * params and scopes, fed by the OAuth identity. Written on every run-invoking MCP call so a
 * run is always attributable; queryable for security review.
 */

export type AuditRow = typeof auditLog.$inferSelect;

export interface AuditEntry {
  /** The invoking principal (OAuth client id, or `"anonymous"` when auth is disabled). */
  principal: string;
  /** The tool/action invoked, e.g. `"run_test"`, `"run_suite"`, `"run_selection"`. */
  action: string;
  /** The test/suite id the action targeted, when it targets one. */
  entryId?: string;
  /** The params the run was invoked with (redacted upstream if sensitive). */
  params?: Record<string, unknown>;
  /** The scopes the principal presented. */
  scopes?: string[];
}

/** Append one audit entry. `at` and `id` are assigned by the database. */
export async function recordAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    principal: entry.principal,
    action: entry.action,
    entryId: entry.entryId ?? null,
    params: entry.params ?? null,
    scopes: entry.scopes ?? null,
  });
}

export interface ListAuditFilter {
  principal?: string;
  entryId?: string;
  action?: string;
  limit?: number;
}

/** Audit query, newest-first — filter by principal, entry, or action. */
export async function listAudit(db: Db, filter: ListAuditFilter = {}): Promise<AuditRow[]> {
  const conds = [];
  if (filter.principal !== undefined) conds.push(eq(auditLog.principal, filter.principal));
  if (filter.entryId !== undefined) conds.push(eq(auditLog.entryId, filter.entryId));
  if (filter.action !== undefined) conds.push(eq(auditLog.action, filter.action));

  return db
    .select()
    .from(auditLog)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(auditLog.id)) // bigserial id → insertion order, newest first
    .limit(filter.limit ?? 100);
}
