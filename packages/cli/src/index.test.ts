import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { run } from "./index";

// `run(argv, root)` is the CLI dispatcher. Pin root to the repo (see commands.test.ts) and
// silence the console so the exit-code contract can be asserted without noise.
const repoRoot = resolve(__dirname, "../../..");

describe("run (CLI dispatcher exit codes)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("list → 0", async () => {
    expect(await run(["list"], repoRoot)).toBe(0);
  });

  it("validate → 0", async () => {
    expect(await run(["validate"], repoRoot)).toBe(0);
  });

  it("run <passing id> → 0", async () => {
    expect(await run(["run", "identity.login"], repoRoot)).toBe(0);
  });

  it("run with no <id> → 1", async () => {
    expect(await run(["run"], repoRoot)).toBe(1);
  });

  it("run with malformed --params JSON → 1", async () => {
    expect(await run(["run", "identity.login", "--params", "{not json"], repoRoot)).toBe(1);
  });

  it("unknown id → 1 (surfaces the command-layer error)", async () => {
    expect(await run(["run", "does.not.exist"], repoRoot)).toBe(1);
  });

  it("unknown command → 1", async () => {
    expect(await run(["bogus"], repoRoot)).toBe(1);
  });

  it("no command → 0 (prints usage)", async () => {
    expect(await run([], repoRoot)).toBe(0);
  });

  it("honors --flag=value form (list --kind=suite)", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await run(["list", "--kind=suite"], repoRoot)).toBe(0);
    // The suite is listed; the two tests are filtered out.
    const output = log.mock.calls.map((c) => String(c[0])).join("\n");
    expect(output).toContain("billing.e2e-refund");
    expect(output).not.toContain("identity.login");
  });
});
