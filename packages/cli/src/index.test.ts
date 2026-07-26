import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "./index";
import { startMockSut } from "./mock-sut";

/** True if `path` exists on disk. */
async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

// `run(argv, root)` is the CLI dispatcher. Pin root to the repo (see commands.test.ts) and
// silence the console so the exit-code contract can be asserted without noise.
const repoRoot = resolve(__dirname, "../../..");
// Corpus-dependent dispatch tests run against the fixture corpus (see commands.test.ts) so
// authoring a product test is never a breaking change to the CLI suite.
const fixtureRoot = resolve(repoRoot, "fixtures/corpus");
const insomniaFixture = resolve(__dirname, "__fixtures__/petstore.insomnia.yaml");

describe("run (CLI dispatcher exit codes)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("list → 0", async () => {
    expect(await run(["list"], fixtureRoot)).toBe(0);
  });

  it("validate → 0", async () => {
    expect(await run(["validate"], fixtureRoot)).toBe(0);
  });

  it("run <passing id> → 0", async () => {
    expect(await run(["run", "alpha.create-widget"], fixtureRoot)).toBe(0);
  });

  it("run with no <id> → 1", async () => {
    expect(await run(["run"], fixtureRoot)).toBe(1);
  });

  it("run with malformed --params JSON → 1", async () => {
    expect(await run(["run", "alpha.create-widget", "--params", "{not json"], fixtureRoot)).toBe(1);
  });

  it("unknown id → 1 (surfaces the command-layer error)", async () => {
    expect(await run(["run", "does.not.exist"], fixtureRoot)).toBe(1);
  });

  it("unknown command → 1", async () => {
    expect(await run(["bogus"], fixtureRoot)).toBe(1);
  });

  it("no command → 0 (prints usage)", async () => {
    expect(await run([], fixtureRoot)).toBe(0);
  });

  it("honors --flag=value form (list --kind=suite)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(["list", "--kind=suite"], fixtureRoot)).toBe(0);
    // The suite is listed; the two tests are filtered out.
    const output = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("alpha.widget-lifecycle");
    expect(output).not.toContain("alpha.create-widget");
  });

  it("rejects an unknown --report format → 1", async () => {
    expect(await run(["run", "alpha.create-widget", "--report", "pdf"], fixtureRoot)).toBe(1);
  });

  it("rejects an unknown flag → 1, naming it rather than silently ignoring it", async () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
    // A swallowed flag is how `--base-url` looked like it worked on `run` while the request
    // went somewhere else entirely.
    expect(await run(["run", "alpha.create-widget", "--baseurl", "http://x"], fixtureRoot)).toBe(1);
    expect(errors.join("\n")).toContain("--baseurl");
  });

  it("rejects a flag that is valid for a different command → 1", async () => {
    // `--base-url` belongs to `run` and `golden`, not `list`.
    expect(await run(["list", "--base-url", "http://x"], fixtureRoot)).toBe(1);
  });
});

describe("run --base-url (choosing the SUT)", () => {
  const preset = process.env.ATP_BASE_URL;
  beforeEach(() => {
    delete process.env.ATP_BASE_URL;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    if (preset === undefined) delete process.env.ATP_BASE_URL;
    else process.env.ATP_BASE_URL = preset;
  });

  it("sends the run at --base-url instead of the built-in mock → 1 when that SUT 404s", async () => {
    const sut = await startMockSut();
    try {
      // A path prefix the mock has no route for. The built-in mock would answer this test
      // happily, so a passing run here would mean the flag had been ignored.
      const args = ["run", "alpha.create-widget", "--base-url", `${sut.url}/nope`];
      expect(await run(args, fixtureRoot)).toBe(1);
    } finally {
      await sut.close();
    }
  });

  it("passes against a --base-url that does serve the routes → 0", async () => {
    const sut = await startMockSut();
    try {
      const args = ["run", "alpha.create-widget", "--base-url", sut.url];
      expect(await run(args, fixtureRoot)).toBe(0);
    } finally {
      await sut.close();
    }
  });
});

describe("run --report (artifact writing)", () => {
  let dir: string;
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), "atp-report-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("writes a markdown artifact to --out", async () => {
    const out = join(dir, "report.md");
    expect(
      await run(["run", "alpha.create-widget", "--report", "md", "--out", out], fixtureRoot),
    ).toBe(0);
    expect(await readFile(out, "utf8")).toContain("# Report — alpha.create-widget");
  });

  it("writes a self-contained html artifact to --out", async () => {
    const out = join(dir, "report.html");
    expect(
      await run(["run", "alpha.create-widget", "--report=html", `--out=${out}`], fixtureRoot),
    ).toBe(0);
    expect(await readFile(out, "utf8")).toContain("<!DOCTYPE html>");
  });
});

describe("import (Insomnia scaffolder)", () => {
  let dir: string;
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    dir = await mkdtemp(join(tmpdir(), "atp-import-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("scaffolds the corpus and a MIGRATION.md under the root → 0", async () => {
    expect(await run(["import", insomniaFixture], dir)).toBe(0);
    expect(await exists(join(dir, "tests/petstore/login.test.ts"))).toBe(true);
    expect(await exists(join(dir, "tests/petstore/billing.suite.ts"))).toBe(true);
    const migration = await readFile(join(dir, "MIGRATION.md"), "utf8");
    expect(migration).toContain("petstore.login");
    expect(migration).toContain("req_login");
  });

  it("missing <insomnia.yaml> → 1", async () => {
    expect(await run(["import"], dir)).toBe(1);
  });
});

describe("import → validate (the strictness gate)", () => {
  // The drafts must compile from a root *under* the repo so `@atp/engine` resolves.
  let dir: string;
  let errors: string[];
  beforeEach(async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    errors = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });
    dir = await mkdtemp(resolve(repoRoot, ".atp-cli-strict-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it("a freshly imported collection fails validate → 1, naming each unfinished node", async () => {
    expect(await run(["import", insomniaFixture], dir)).toBe(0);

    expect(await run(["validate"], dir)).toBe(1);
    const output = errors.join("\n");
    expect(output).toContain("petstore.billing#refund-invoice");
    expect(output).toContain("unwired-chain");
    expect(output).toContain("non-pinning-assert");
  });
});

describe("golden (live parity capture)", () => {
  const preset = process.env.ATP_BASE_URL;
  let logs: string[];
  let errors: string[];
  beforeEach(() => {
    delete process.env.ATP_BASE_URL;
    // `beta.read-widget` authenticates, so its credential has to reach the run the way a real
    // one does — injected as ATP_SECRET_<KEY> and collected into the `{{secrets.*}}` bag.
    process.env.ATP_SECRET_FIXTURE_TOKEN = "fixture-tok";
    logs = [];
    errors = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(" "));
    });
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.ATP_SECRET_FIXTURE_TOKEN;
    if (preset === undefined) delete process.env.ATP_BASE_URL;
    else process.env.ATP_BASE_URL = preset;
  });

  it("missing <id> → 1", async () => {
    expect(await run(["golden"], fixtureRoot)).toBe(1);
  });

  it("no base URL → 1, naming the flag instead of silently using the mock SUT", async () => {
    expect(await run(["golden", "beta.read-widget"], fixtureRoot)).toBe(1);
    expect(errors.join("\n")).toContain("--base-url");
  });

  it("refuses to emit from a partial run → 1, naming the nodes that never executed", async () => {
    const sut = await startMockSut();
    try {
      // Point the suite at a path prefix the mock has no route for: its first node gets a 404
      // (a real baseline), fails `status eq 200`, and every downstream node is skipped — so
      // there is nothing to derive their parity assertions from.
      const args = ["golden", "alpha.widget-lifecycle", "--base-url", `${sut.url}/nope`];
      expect(await run(args, fixtureRoot)).toBe(1);

      const warning = errors.join("\n");
      expect(warning).toContain("capture");
      // The one node that did execute is still emitted, so the capture is not wasted.
      expect(logs.join("\n")).toContain('{ path: "status", op: "eq", value: 404 }');
    } finally {
      await sut.close();
    }
  });

  it("prints a paste-ready assert block per node against the given SUT → 0", async () => {
    const sut = await startMockSut();
    try {
      expect(await run(["golden", "beta.read-widget", "--base-url", sut.url], fixtureRoot)).toBe(0);
      const output = logs.join("\n");
      expect(output).toContain("read");
      expect(output).toContain('{ path: "status", op: "eq", value: 200 }');
      expect(output).toContain('{ path: "body.amount", op: "isNumber" }');
    } finally {
      await sut.close();
    }
  });
});
