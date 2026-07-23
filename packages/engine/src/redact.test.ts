import { describe, expect, it } from "vitest";

import { redactRequest, redactResponse } from "./redact";

describe("redactRequest", () => {
  it("masks sensitive header keys wholesale", () => {
    const out = redactRequest(
      {
        method: "GET",
        url: "https://x/y",
        headers: { authorization: "Bearer tok", "x-api-key": "k", accept: "application/json" },
      },
      [],
    );
    expect(out.headers).toEqual({
      authorization: "***",
      "x-api-key": "***",
      accept: "application/json",
    });
  });

  it("masks secret values wherever they appear in the body", () => {
    const out = redactRequest(
      {
        method: "POST",
        url: "https://x/login",
        body: { password: "hunter2", note: "pw is hunter2", nested: { p: "hunter2" } },
      },
      ["hunter2"],
    );
    expect(out.body).toEqual({ password: "***", note: "pw is ***", nested: { p: "***" } });
  });
});

describe("redactResponse", () => {
  it("masks secret values in the response body and defaults headers", () => {
    const out = redactResponse(
      { status: 200, headers: {}, body: { token: "s3cret" }, timingMs: 5 },
      ["s3cret"],
    );
    expect(out).toEqual({ status: 200, headers: {}, body: { token: "***" }, timingMs: 5 });
  });
});
