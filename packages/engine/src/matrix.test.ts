import { describe, expect, it } from "vitest";

import { expandMatrix, expandUnits, resolveEnv } from "./matrix";

describe("expandMatrix", () => {
  it("produces the cartesian product in authored (row-major) order", () => {
    const cells = expandMatrix({ region: ["us", "eu", "ap"], tier: ["free", "pro"] });
    expect(cells.map((c) => c.coords)).toEqual([
      { region: "us", tier: "free" },
      { region: "us", tier: "pro" },
      { region: "eu", tier: "free" },
      { region: "eu", tier: "pro" },
      { region: "ap", tier: "free" },
      { region: "ap", tier: "pro" },
    ]);
  });

  it("gives each cell a stable `dim=value` key in authored dimension order", () => {
    const cells = expandMatrix({ region: ["us", "eu"], tier: ["free", "pro"] });
    expect(cells.map((c) => c.key)).toEqual([
      "region=us,tier=free",
      "region=us,tier=pro",
      "region=eu,tier=free",
      "region=eu,tier=pro",
    ]);
  });

  it("handles a single dimension", () => {
    expect(expandMatrix({ region: ["us", "eu"] })).toEqual([
      { coords: { region: "us" }, key: "region=us" },
      { coords: { region: "eu" }, key: "region=eu" },
    ]);
  });

  it("stringifies non-string dimension values in the key but keeps them typed in coords", () => {
    const cells = expandMatrix({ replicas: [1, 3] });
    expect(cells.map((c) => c.key)).toEqual(["replicas=1", "replicas=3"]);
    expect(cells[0]?.coords).toEqual({ replicas: 1 });
  });
});

describe("resolveEnv", () => {
  it("returns a static env object unchanged", () => {
    expect(resolveEnv({ baseUrl: "https://api" }, { region: "us" })).toEqual({
      baseUrl: "https://api",
    });
  });

  it("calls a matrix-derived env builder with the cell coordinates (§7.3)", () => {
    const env = resolveEnv((m) => ({ baseUrl: `https://${String(m.region)}.api` }), {
      region: "eu",
    });
    expect(env).toEqual({ baseUrl: "https://eu.api" });
  });

  it("returns undefined when no env is authored", () => {
    expect(resolveEnv(undefined, {})).toBeUndefined();
  });
});

describe("expandUnits", () => {
  it("returns a single base unit (no `#` suffix) when there is no matrix", () => {
    expect(expandUnits({ id: "identity.login", env: { baseUrl: "x" } })).toEqual([
      { id: "identity.login", matrix: {}, env: { baseUrl: "x" } },
    ]);
  });

  it("treats an empty matrix like no matrix (one base unit)", () => {
    expect(expandUnits({ id: "t", matrix: {} })).toEqual([{ id: "t", matrix: {}, env: undefined }]);
  });

  it("enumerates one discrete, named unit per matrix cell with per-cell env (§7.3)", () => {
    const units = expandUnits({
      id: "identity.login.matrix",
      matrix: { region: ["us", "eu"], tier: ["free", "pro"] },
      env: (m) => ({ baseUrl: `https://${String(m.region)}.api`, tier: m.tier }),
    });
    expect(units).toHaveLength(4);
    expect(units[0]).toEqual({
      id: "identity.login.matrix#region=us,tier=free",
      matrix: { region: "us", tier: "free" },
      env: { baseUrl: "https://us.api", tier: "free" },
    });
    expect(units[3]?.id).toBe("identity.login.matrix#region=eu,tier=pro");
    // Each unit id is unique — the ids are the addressable executable units an agent runs.
    expect(new Set(units.map((u) => u.id)).size).toBe(4);
  });
});
