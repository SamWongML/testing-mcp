import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { compile } from "@atp/compile";
import { afterEach, describe, expect, it } from "vitest";

import { importInsomnia, type ImportResult } from "./import";

/** Repo root (module resolution for `@atp/engine` in the generated drafts walks up to it). */
const repoRoot = resolve(__dirname, "../../..");

/** Load the committed Insomnia v5 fixture and run it through the deterministic scaffolder. */
async function importFixture(): Promise<ImportResult> {
  const yaml = await readFile(resolve(__dirname, "__fixtures__/petstore.insomnia.yaml"), "utf8");
  return importInsomnia(yaml);
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
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("writes drafts that `compile()` normalizes into manifest entries", async () => {
    const result = await importFixture();
    // A throwaway corpus root *under repoRoot* so `@atp/engine` resolves from its node_modules.
    tmp = await mkdtemp(resolve(repoRoot, ".atp-import-rt-"));
    for (const f of result.files) {
      const abs = resolve(tmp, f.path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, f.content, "utf8");
    }

    const manifest = await compile({ root: tmp });
    const ids = manifest.entries.map((e) => e.id);
    expect(ids).toContain("petstore.login");
    expect(ids).toContain("petstore.billing");
  });
});
