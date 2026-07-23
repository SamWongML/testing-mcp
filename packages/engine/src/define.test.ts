import { describe, expect, it } from "vitest";

import { defineEnv, defineTest } from "./define";

describe("defineTest", () => {
  it("returns the authored test unchanged", () => {
    const test = defineTest({
      id: "identity.login",
      version: 1,
      steps: [{ id: "s", request: { method: "GET", url: "/" } }],
    });
    expect(test.id).toBe("identity.login");
  });

  it("rejects a missing id", () => {
    expect(() =>
      defineTest({
        id: "",
        version: 1,
        steps: [{ id: "s", request: { method: "GET", url: "/" } }],
      }),
    ).toThrow(/id/);
  });

  it("rejects a non-positive version", () => {
    expect(() =>
      defineTest({
        id: "x",
        version: 0,
        steps: [{ id: "s", request: { method: "GET", url: "/" } }],
      }),
    ).toThrow(/version/);
  });

  it("rejects an empty step list", () => {
    expect(() => defineTest({ id: "x", version: 1, steps: [] })).toThrow(/at least one step/);
  });
});

describe("defineEnv", () => {
  it("returns the env object unchanged", () => {
    const env = defineEnv({ baseUrl: "https://staging.example.com" });
    expect(env.baseUrl).toBe("https://staging.example.com");
  });
});
