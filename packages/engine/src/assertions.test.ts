import { describe, expect, it } from "vitest";

import type { EngineResponse } from "./context";
import { evaluateAssertion, evaluateAssertions } from "./assertions";

const response: EngineResponse = {
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
  body: { token: "abc", count: 3, tags: ["a", "b"], user: { id: "u1" }, expiresIn: 60 },
};

describe("evaluateAssertion — declarative operators", () => {
  it("eq / neq compare by deep equality", () => {
    expect(evaluateAssertion({ path: "status", op: "eq", value: 200 }, response).ok).toBe(true);
    expect(evaluateAssertion({ path: "status", op: "neq", value: 500 }, response).ok).toBe(true);
    expect(evaluateAssertion({ path: "status", op: "eq", value: 500 }, response).ok).toBe(false);
  });

  it("gt / lt compare numerically", () => {
    expect(evaluateAssertion({ path: "body.count", op: "gt", value: 2 }, response).ok).toBe(true);
    expect(evaluateAssertion({ path: "body.count", op: "lt", value: 2 }, response).ok).toBe(false);
  });

  it("contains works on strings and arrays", () => {
    expect(
      evaluateAssertion(
        { path: "headers.content-type", op: "contains", value: "application/json" },
        response,
      ).ok,
    ).toBe(true);
    expect(evaluateAssertion({ path: "body.tags", op: "contains", value: "b" }, response).ok).toBe(
      true,
    );
    expect(evaluateAssertion({ path: "body.tags", op: "contains", value: "z" }, response).ok).toBe(
      false,
    );
  });

  it("matches applies a regex", () => {
    expect(evaluateAssertion({ path: "body.token", op: "matches", value: "^a" }, response).ok).toBe(
      true,
    );
  });

  it("isString / isNumber check types", () => {
    expect(evaluateAssertion({ path: "body.token", op: "isString" }, response).ok).toBe(true);
    expect(evaluateAssertion({ path: "body.count", op: "isNumber" }, response).ok).toBe(true);
    expect(evaluateAssertion({ path: "body.token", op: "isNumber" }, response).ok).toBe(false);
  });

  it("jsonSchema validates response shape", () => {
    const schema = {
      type: "object",
      required: ["token"],
      properties: { token: { type: "string" } },
    };
    expect(evaluateAssertion({ path: "body", op: "jsonSchema", value: schema }, response).ok).toBe(
      true,
    );
    const bad = { type: "object", properties: { token: { type: "number" } } };
    expect(evaluateAssertion({ path: "body", op: "jsonSchema", value: bad }, response).ok).toBe(
      false,
    );
  });

  it("jsonpath queries the whole response", () => {
    expect(
      evaluateAssertion({ path: "$.body.user.id", op: "jsonpath", value: "u1" }, response).ok,
    ).toBe(true);
    expect(
      evaluateAssertion({ path: "$.body.tags[0]", op: "jsonpath", value: "a" }, response).ok,
    ).toBe(true);
    expect(evaluateAssertion({ path: "$.body.missing", op: "jsonpath" }, response).ok).toBe(false);
  });

  it("records op/path/expected/actual for diagnostics", () => {
    const r = evaluateAssertion({ path: "status", op: "eq", value: 201 }, response);
    expect(r).toMatchObject({ ok: false, op: "eq", path: "status", expected: 201, actual: 200 });
  });
});

describe("evaluateAssertion — fn escape hatch", () => {
  it("executes the predicate against the response", () => {
    const r = evaluateAssertion(
      { fn: (res) => (res as EngineResponse).status === 200, message: "must be 200" },
      response,
    );
    expect(r.ok).toBe(true);
    expect(r.op).toBeUndefined();
  });

  it("treats a thrown predicate as a failed assertion", () => {
    const r = evaluateAssertion(
      {
        fn: () => {
          throw new Error("boom");
        },
      },
      response,
    );
    expect(r.ok).toBe(false);
  });
});

describe("evaluateAssertions", () => {
  it("evaluates a list in order", () => {
    const results = evaluateAssertions(
      [
        { path: "status", op: "eq", value: 200 },
        { path: "body.token", op: "isString" },
      ],
      response,
    );
    expect(results.map((r) => r.ok)).toEqual([true, true]);
  });
});
