# Progress Tracker — API Testing Platform

**Plan:** [docs/implementation-plan.md](./implementation-plan.md) · **Architecture:** [docs/research.md](./research.md)
**Deferred work:** [docs/deferred.md](./deferred.md) · **Session log:** [docs/phases/session-log.md](./phases/session-log.md)

> **Every session:** find the first phase below not `✅ done`, read its handoff notes *in this
> file*, read that phase's section in the plan, verify the previous phase's exit criteria,
> build, then update this file (status, checkboxes, handoff notes), append one row to
> `docs/phases/session-log.md`, commit, and push before ending the session.

> **This file is the index — keep it under 150 lines.** Notes for `✅ done` phases live in
> `docs/phases/P<n>.md`. Read one **only** if the current phase revisits that work; they are
> not session-start reading. See [Archiving a finished phase](#archiving-a-finished-phase).

**Status legend:** ⬜ not started · 🔄 in progress · ✅ done · ⏸ blocked

## Phase status

| Phase | Title | Status | Session(s) | Exit criteria verified | Notes |
|---|---|---|---|---|---|
| P0 | Monorepo foundation | ✅ | 2026-07-23 | ✅ | [phases/P0.md](./phases/P0.md) |
| P1 | Schema package (`@atp/schema`) | ✅ | 2026-07-23 | ✅ | [phases/P1.md](./phases/P1.md) |
| P2 | Engine I — single-test execution | ✅ | 2026-07-23 | ✅ | [phases/P2.md](./phases/P2.md) |
| P3 | Engine II — suites/DAG/auth/matrix | ✅ | 2026-07-23 | ✅ | [phases/P3.md](./phases/P3.md) |
| P4 | Compile + CLI + sample corpus | ✅ | 2026-07-23 | ✅ | [phases/P4.md](./phases/P4.md) |
| P5 | Reporting renderers | ✅ | 2026-07-23 | ✅ | [phases/P5.md](./phases/P5.md) |
| P6 | Store — Postgres record + queue + artifacts | ✅ | 2026-07-23 | ✅ | [phases/P6.md](./phases/P6.md) |
| P7 | MCP server — sync surface | ✅ | 2026-07-24 | ✅ | [phases/P7.md](./phases/P7.md) |
| P8 | Worker + MCP Tasks — async lifecycle | ⬜ | — | — | ← **current** |
| P9 | Prompts + Insomnia migration | ⬜ | — | — | |
| P10 | AuthN/Z + observability | ⬜ | — | — | |
| P11 | CDK infra + DynamoDB adapter | ⬜ | — | — | |

---

## Current phase

### P8 — Worker + Tasks (async)
- [ ] `tasks.ts` lifecycle glue (SEP-1686 mapping onto TaskStateStore + queue)
- [ ] `worker.ts` (claim loop, heartbeat, progress, artifacts, terminal state)
- [ ] Tools: `run_suite` `run_selection` auto-task `run_test`; `get_run` `get_run_result` `cancel_run`
- [ ] Cancellation end-to-end (flag → AbortSignal)
- [ ] Reaper wired; idempotency keys
- [ ] Integration tests: complete / cancel / crash-requeue / non-Task client path
- [ ] `pnpm dev:worker`; two-process dev flow documented

**Handoff notes:** _none yet_

**Entering P8, read:** plan §P8 · research §11, §8.2/§8.5, ADR-004 · [docs/deferred.md](./deferred.md)
(it carries P2/P3 items P8 inherits) · [phases/P7.md](./phases/P7.md) for the exact next step
left by P7. **The SDK Task API is experimental — verify it against the installed SDK source /
Context7, not memory (§23).**

---

## Upcoming phases

### P9 — Prompts + migration
- [ ] Prompts: `import_insomnia_collection` `author_new_test` `triage_failure` `generate_suite` `regenerate_reports`
- [ ] `atp import` deterministic scaffolder (§13.1 mapping) + fixture tests
- [ ] Golden-master parity helper
- [ ] `MIGRATION.md` template; `regenerate_reports` impl
- [ ] `CLAUDE.md` finalized (recipes + full surface reference)

### P10 — Auth + observability
- [ ] OAuth 2.1 (`jose`, RFC 9728/8707), `test:read`/`test:run` scopes, dev-off flag
- [ ] Audit log on run-invoking calls
- [ ] Pino everywhere with runId/taskId/traceId/nodeId + log redaction
- [ ] OTel tracing (MCP call → run → SUT call spans)
- [ ] Metrics incl. `queue_depth` for autoscaling
- [ ] Tests: scope rejection, audit rows, correlation ids

### P11 — Infra + DynamoDB
- [ ] Dockerfile (MODE=server|worker, tini, graceful shutdown)
- [ ] CDK stacks: network / data / ecs / observability
- [ ] `DynamoTaskStore` + idempotency adapter + config-based store selection
- [ ] (Optional) `RunTask` escape hatch for very long runs
- [ ] `cdk synth` in CI; `docs/deploy.md` runbook

---

## Archiving a finished phase

When a phase reaches `✅ done`, before committing:

1. Move its checklist + handoff notes out of **Current phase** into `docs/phases/P<n>.md`
   (title `# P<n> — <name>`, plus the standard breadcrumb line the other archives carry).
2. Flip its row in the table to `✅` and point the Notes column at that file.
3. Promote the next phase's stub from **Upcoming phases** into **Current phase**, and record
   under *Entering P<n>, read* the exact next step, plan §, and research § it needs.
4. Append one row to [docs/phases/session-log.md](./phases/session-log.md) — **not** to this file.
5. Park anything discovered that belongs to a later phase in [docs/deferred.md](./deferred.md).

This keeps session-start reading flat as phases accumulate: the handoff notes for done work
are one `Read` away when a phase actually needs them, and cost nothing when it doesn't.
