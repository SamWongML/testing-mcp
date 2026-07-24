import { describe, expect, it } from "vitest";

import { goldenAssertions, renderAssertions } from "./golden";

/**
 * Golden-master parity (research §19 step 4): capture a baseline response for a migrated
 * request, derive assertions that prove a re-run reproduces it (status + key-field shape).
 */
describe("goldenAssertions — baseline → parity assertions", () => {
  it("asserts the status exactly", () => {
    const asserts = goldenAssertions({ status: 201, body: {} });
    expect(asserts).toContainEqual({ path: "status", op: "eq", value: 201 });
  });

  it("derives shape assertions for scalar key fields", () => {
    const asserts = goldenAssertions({
      status: 200,
      body: { token: "abc", expiresIn: 3600, ok: true },
    });
    // Strings/numbers assert type (values vary run-to-run); booleans assert the exact value.
    expect(asserts).toContainEqual({ path: "body.token", op: "isString" });
    expect(asserts).toContainEqual({ path: "body.expiresIn", op: "isNumber" });
    expect(asserts).toContainEqual({ path: "body.ok", op: "eq", value: true });
  });

  it("does not fabricate assertions for nested objects/arrays it cannot compare field-wise", () => {
    const asserts = goldenAssertions({ status: 200, body: { user: { id: 1 }, items: [1, 2] } });
    const paths = asserts.map((a) => a.path);
    expect(paths).not.toContain("body.user");
    expect(paths).not.toContain("body.items");
  });
});

describe("renderAssertions — TS source for pasting into a migrated test", () => {
  it("renders an assertion array literal", () => {
    const src = renderAssertions([{ path: "status", op: "eq", value: 200 }]);
    expect(src).toContain('{ path: "status", op: "eq", value: 200 }');
  });
});
