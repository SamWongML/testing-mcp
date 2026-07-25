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
| P8 | Worker + MCP Tasks — async lifecycle | ✅ | 2026-07-24 | ✅ | [phases/P8.md](./phases/P8.md) |
| P9 | Prompts + Insomnia migration | ✅ | 2026-07-24 | ✅ | [phases/P9.md](./phases/P9.md) |
| P10 | AuthN/Z + observability | ✅ | 2026-07-25 | ✅ | [phases/P10.md](./phases/P10.md) |
| P11 | CDK infra + DynamoDB adapter | ✅ | 2026-07-25 | ✅ | [phases/P11.md](./phases/P11.md) |

---

## Current phase

_None — **P0–P11 are complete**. The platform is built, tested, and deployable._

**What exists:** the full pipeline (authored `defineTest`/`defineSuite` → manifest → engine →
renderers), the MCP server's sync + async surfaces with prompts and resources, the Postgres
store + worker, OAuth 2.1 + observability, and P11's AWS deployment layer (CDK stacks, the
`MODE=server|worker|migrate` image, DynamoDB/S3 adapters selected by config).

**Starting new work?** There is no next phase to read into. Pick up from
[docs/deferred.md](./deferred.md) — it is the standing backlog of work earlier phases parked,
now the only queue. Verify the gate first (`pnpm typecheck && pnpm lint && pnpm test &&
pnpm compile && pnpm validate && pnpm synth`); with the services from `docker-compose.dev.yml`
up and `ATP_TEST_DATABASE_URL` / `ATP_TEST_DYNAMO_ENDPOINT` / `ATP_TEST_S3_ENDPOINT` set, the
suite is **535 passed | 0 skipped**. Deploying: [docs/deploy.md](./deploy.md).

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
