import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { artifactKey, LocalArtifactStore } from "./artifacts";

describe("artifactKey", () => {
  it("builds the §16.3 layout from a fixed date (UTC)", () => {
    const key = artifactKey({
      env: "local",
      runId: "run-1",
      name: "trace.json",
      now: new Date("2026-07-05T00:00:00Z"),
    });
    expect(key).toBe("local/2026/07/05/run-1/trace.json");
  });
});

describe("LocalArtifactStore", () => {
  let base: string;
  let store: LocalArtifactStore;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "atp-artifacts-"));
    store = new LocalArtifactStore(base);
  });
  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("puts a blob, creating nested dirs, and reads it back", async () => {
    const key = "local/2026/07/05/run-1/report.md";
    const res = await store.put(key, "# hello");
    expect(res.key).toBe(key);
    expect(res.uri.startsWith("file://")).toBe(true);

    const got = await store.get(key);
    expect(got.toString("utf8")).toBe("# hello");

    // Written at the expected on-disk location.
    const onDisk = await readFile(join(base, key), "utf8");
    expect(onDisk).toBe("# hello");
  });

  it("round-trips binary bodies", async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await store.put("bin/blob", bytes);
    const got = await store.get("bin/blob");
    expect([...got]).toEqual([...bytes]);
  });

  it("uri and presign point at the file", async () => {
    await store.put("a/b.txt", "x");
    const uri = store.uri("a/b.txt");
    expect(fileURLToPath(uri)).toBe(join(base, "a/b.txt"));
    expect(await store.presign("a/b.txt")).toBe(uri);
  });

  it("rejects keys that escape the base directory", async () => {
    await expect(store.put("../evil", "x")).rejects.toThrow(/escapes base dir/);
    await expect(store.get("../../etc/passwd")).rejects.toThrow(/escapes base dir/);
  });
});
