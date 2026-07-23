import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { discover } from "./discover";

const okDir = resolve(__dirname, "../fixtures/ok");

describe("discover", () => {
  it("finds *.test.ts and *.suite.ts files, sorted, ignoring other files", async () => {
    const files = await discover(okDir);
    expect(files.map((f) => f.replace(`${okDir}/`, ""))).toEqual([
      "alpha.test.ts",
      "beta.suite.ts",
    ]);
    // `helper.ts` is neither a test nor a suite — it must not be discovered.
    expect(files.some((f) => f.endsWith("helper.ts"))).toBe(false);
  });

  it("returns absolute paths", async () => {
    const files = await discover(okDir);
    expect(files.every((f) => f.startsWith("/"))).toBe(true);
  });

  it("returns an empty list for a directory that does not exist", async () => {
    const files = await discover(resolve(okDir, "does-not-exist"));
    expect(files).toEqual([]);
  });
});
