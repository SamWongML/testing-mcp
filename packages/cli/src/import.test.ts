import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { compile } from "@atp/compile";
import type { Manifest } from "@atp/schema";
import { describe, expect, it } from "vitest";

import { importInsomnia, renderMigration, type ImportResult } from "./import";
import { strictViolations } from "./strict";

/** Repo root (module resolution for `@atp/engine` in the generated drafts walks up to it). */
const repoRoot = resolve(__dirname, "../../..");

/** Load the committed Insomnia v5 fixture and run it through the deterministic scaffolder. */
async function importFixture(): Promise<ImportResult> {
  const yaml = await readFile(resolve(__dirname, "__fixtures__/petstore.insomnia.yaml"), "utf8");
  return importInsomnia(yaml);
}

/** Compile a set of generated drafts in a throwaway corpus under repoRoot. */
async function compileDrafts(result: ImportResult): Promise<Manifest> {
  const tmp = await mkdtemp(resolve(repoRoot, ".atp-import-rt-"));
  try {
    for (const f of result.files) {
      const abs = resolve(tmp, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
    }
    return await compile({ root: tmp });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The entry ids a set of drafts compiles to. */
async function compiledIds(result: ImportResult): Promise<string[]> {
  return (await compileDrafts(result)).entries.map((e) => e.id);
}

/** Find the one generated file whose path ends with `suffix` (fails if absent/ambiguous). */
function fileEndingWith(result: ImportResult, suffix: string): string {
  const matches = result.files.filter((f) => f.path.endsWith(suffix));
  expect(matches, `exactly one generated file ending with "${suffix}"`).toHaveLength(1);
  return matches[0]!.content;
}

describe("importInsomnia — request → defineTest (§13.1)", () => {
  it("maps a top-level request to a defineTest with the mapped id, method, and url", async () => {
    const result = await importFixture();
    const login = fileEndingWith(result, "tests/petstore/login.test.ts");

    expect(login).toContain('import { defineTest } from "@atp/engine"');
    expect(login).toContain('id: "petstore.login"');
    expect(login).toContain('method: "POST"');
    // Insomnia `{{ _.baseUrl }}` template tags become `{{env.baseUrl}}` (env-sourced vars).
    expect(login).toContain('url: "{{env.baseUrl}}/auth/login"');
  });
});

describe("importInsomnia — environment → tests/_shared/env (§13.1)", () => {
  it("emits a defineEnv from environments.data and wires it into each entry", async () => {
    const result = await importFixture();
    const env = fileEndingWith(result, "tests/_shared/env/petstore.ts");

    expect(env).toContain('import { defineEnv } from "@atp/engine"');
    expect(env).toContain("export const petstore = defineEnv(");
    expect(env).toContain('baseUrl: "https://api.petstore.example"');
    expect(env).toContain('invoiceId: "inv_123"');

    // The generated test imports the shared env and passes it as `env`.
    const login = fileEndingWith(result, "tests/petstore/login.test.ts");
    expect(login).toContain('import { petstore } from "../_shared/env/petstore"');
    expect(login).toContain("env: petstore,");
  });
});

describe("importInsomnia — headers, JSON body, auth (§13.1)", () => {
  it("maps headers, a JSON body (with template tags), and bearer auth to authRef", async () => {
    const result = await importFixture();
    const login = fileEndingWith(result, "tests/petstore/login.test.ts");

    // Header names are lowercased (HTTP is case-insensitive; matches the corpus convention).
    expect(login).toContain('"content-type": "application/json"');
    // The application/json body text becomes an object literal with mapped {{env.*}} tags.
    expect(login).toContain('email: "{{env.email}}"');
    expect(login).toContain('password: "{{env.password}}"');
    // Bearer auth is referenced by id; the secret stays a {{secrets.*}} template.
    expect(login).toContain('authRef: "petstore"');

    const auth = fileEndingWith(result, "tests/_shared/auth/petstore.ts");
    expect(auth).toContain('import { bearerAuth } from "@atp/engine"');
    expect(auth).toContain('id: "petstore"');
    expect(auth).toContain("{{secrets.");
  });
});

describe("importInsomnia — folder → defineSuite (§13.1)", () => {
  it("maps a request group to a suite with a node per child request", async () => {
    const result = await importFixture();
    const suite = fileEndingWith(result, "tests/petstore/billing.suite.ts");

    expect(suite).toContain('import { defineSuite } from "@atp/engine"');
    expect(suite).toContain('id: "petstore.billing"');
    expect(suite).toContain('"get-invoice"');
    expect(suite).toContain('"refund-invoice"');
    expect(suite).toContain('method: "GET"');
    expect(suite).toContain('url: "{{env.baseUrl}}/invoices/{{env.invoiceId}}"');
  });

  it("leaves the messy remainder (response-ref chaining) as a TODO for the agent/prompt", async () => {
    const result = await importFixture();
    const suite = fileEndingWith(result, "tests/petstore/billing.suite.ts");

    // The Insomnia `{% response ... %}` tag is not silently resolved: it becomes a TODO marker
    // plus a placeholder, so the deterministic scaffold compiles and the agent wires the chain.
    expect(suite).toContain("TODO");
    expect(suite).toContain("import_insomnia_collection");
    expect(suite).toContain("__TODO_CHAIN__");
  });
});

describe("importInsomnia — Insomnia id → IR id mapping (MIGRATION.md, §19)", () => {
  it("records a mapping row per request and folder, keyed by Insomnia meta id", async () => {
    const { mapping } = await importFixture();
    const by = (insomniaId: string) => mapping.find((m) => m.insomniaId === insomniaId);

    expect(by("req_login")).toMatchObject({ irId: "petstore.login", kind: "test" });
    expect(by("fld_billing")).toMatchObject({ irId: "petstore.billing", kind: "suite" });
    // A folder's child requests map to suite nodes, addressed as `<suiteId>#<nodeId>`.
    expect(by("req_get_invoice")).toMatchObject({ irId: "petstore.billing#get-invoice" });
    expect(by("req_refund")).toMatchObject({ irId: "petstore.billing#refund-invoice" });
  });
});

describe("importInsomnia — generated drafts compile (P9 exit criterion)", () => {
  it("writes drafts that `compile()` normalizes into manifest entries", async () => {
    const ids = await compiledIds(await importFixture());
    expect(ids).toContain("petstore.login");
    expect(ids).toContain("petstore.billing");
  });
});

describe("importInsomnia — fresh drafts are inert until finished (§19)", () => {
  it("fails `atp validate` strictness, so a half-migrated corpus cannot ship green", async () => {
    const violations = strictViolations(await compileDrafts(await importFixture()));
    const nodesFlagged = (rule: string) =>
      violations
        .filter((v) => v.rule === rule)
        .map((v) => `${v.entryId}#${v.nodeId}`)
        .sort();

    // The refund request chains off Get Invoice via an Insomnia `{% response %}` tag, which the
    // deterministic importer leaves as `__TODO_CHAIN__` in the body — an unwired request that
    // would 404 in a real run.
    expect(nodesFlagged("unwired-chain")).toEqual(["petstore.billing#refund-invoice"]);
    // And every scaffolded node carries only `status lt 500`, which that 404 satisfies.
    expect(nodesFlagged("non-pinning-assert")).toEqual([
      "petstore.billing#get-invoice",
      "petstore.billing#refund-invoice",
      "petstore.login#login",
    ]);
  });
});

describe("importInsomnia — robustness on realistic collection shapes", () => {
  it("flattens nested folders into suite nodes (never emits an empty, non-compiling suite)", async () => {
    // A folder whose only children are folders: the naive one-level filter would yield `nodes: {}`,
    // which `defineSuite` rejects at compile → contradicts the exit criterion.
    const result = importInsomnia(`
type: collection.insomnia.rest/5.0
name: Nested
collection:
  - name: Outer
    meta: { id: fld_outer }
    children:
      - name: Inner
        meta: { id: fld_inner }
        children:
          - name: Deep Get
            method: GET
            url: "{{ _.baseUrl }}/deep"
            meta: { id: req_deep }
environments:
  data:
    baseUrl: https://x
`);
    const suite = fileEndingWith(result, "tests/nested/outer.suite.ts");
    expect(suite).toContain('"deep-get"');
    expect(suite).toContain('method: "GET"');
    // And it must actually compile.
    expect(await compiledIds(result)).toContain("nested.outer");
  });

  it("disambiguates colliding name-slugs instead of silently clobbering", async () => {
    const { mapping, files } = importInsomnia(`
type: collection.insomnia.rest/5.0
name: Dup
collection:
  - name: Get Thing
    method: GET
    url: "{{ _.baseUrl }}/a"
    meta: { id: req_a }
  - name: Get Thing
    method: GET
    url: "{{ _.baseUrl }}/b"
    meta: { id: req_b }
environments: { data: { baseUrl: https://x } }
`);
    const irIds = mapping.filter((m) => m.kind === "test").map((m) => m.irId);
    expect(new Set(irIds).size).toBe(2); // no collision
    expect(irIds).toContain("dup.get-thing");
    expect(irIds).toContain("dup.get-thing-2");
    // Two distinct files on disk, so neither request is lost.
    const testPaths = new Set(files.filter((f) => f.path.endsWith(".test.ts")).map((f) => f.path));
    expect(testPaths.size).toBe(2);
  });

  it("emits one provider per distinct bearer token (no silent wrong-credential collapse)", async () => {
    const result = importInsomnia(`
type: collection.insomnia.rest/5.0
name: Auth
collection:
  - name: User Call
    method: GET
    url: "{{ _.baseUrl }}/u"
    authentication: { type: bearer, token: "{{ _.userToken }}" }
    meta: { id: req_u }
  - name: Admin Call
    method: GET
    url: "{{ _.baseUrl }}/a"
    authentication: { type: bearer, token: "{{ _.adminToken }}" }
    meta: { id: req_admin }
environments: { data: { baseUrl: https://x } }
`);
    const user = fileEndingWith(result, "tests/auth/user-call.test.ts");
    const admin = fileEndingWith(result, "tests/auth/admin-call.test.ts");
    expect(user).toContain('authRef: "auth-user-token"');
    expect(admin).toContain('authRef: "auth-admin-token"');
    // Two auth files, each carrying its own secret.
    expect(fileEndingWith(result, "tests/_shared/auth/auth-user-token.ts")).toContain(
      "{{secrets.USER_TOKEN}}",
    );
    expect(fileEndingWith(result, "tests/_shared/auth/auth-admin-token.ts")).toContain(
      "{{secrets.ADMIN_TOKEN}}",
    );
  });

  it("flags non-bearer auth with a TODO instead of silently dropping it", async () => {
    const result = importInsomnia(`
type: collection.insomnia.rest/5.0
name: Basic
collection:
  - name: Secure
    method: GET
    url: "{{ _.baseUrl }}/s"
    authentication: { type: basic, username: u, password: p }
    meta: { id: req_s }
environments: { data: { baseUrl: https://x } }
`);
    const secure = fileEndingWith(result, "tests/basic/secure.test.ts");
    expect(secure).toContain("TODO");
    expect(secure).toContain("basic");
    // It must not emit an authRef *field* on the request (the TODO prose may mention authRef).
    expect(secure).not.toContain('authRef: "');
  });

  it("marks a top-level chained request with a TODO (consistent with suite nodes)", async () => {
    const result = importInsomnia(`
type: collection.insomnia.rest/5.0
name: Chain
collection:
  - name: First
    method: GET
    url: "{{ _.baseUrl }}/first"
    meta: { id: req_first }
  - name: Second
    method: GET
    url: "{{ _.baseUrl }}/second/{% response 'body', 'req_first', 'b64::JC5pZA==::46b', 'never' %}"
    meta: { id: req_second }
environments: { data: { baseUrl: https://x } }
`);
    const second = fileEndingWith(result, "tests/chain/second.test.ts");
    expect(second).toContain("TODO");
    expect(second).toContain("__TODO_CHAIN__");
  });
});

describe("renderMigration", () => {
  it("escapes `|` in cell values so a pipe in a name can't break the table", () => {
    const md = renderMigration(
      [{ insomniaId: "req_x", insomniaName: "A | B", irId: "d.x", kind: "test", path: "p" }],
      "src.yaml",
    );
    expect(md).toContain("A \\| B");
    expect(md).not.toContain("A | B |");
  });
});
