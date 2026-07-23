import { describe, expect, it } from "vitest";

import type { EngineResponse } from "./context";
import { extract } from "./extract";

const response: EngineResponse = {
  status: 200,
  headers: { location: "/orders/9" },
  body: { token: "abc", user: { id: "u1" } },
};

describe("extract", () => {
  it("reads dot-paths from body, status and headers", () => {
    expect(
      extract(
        [
          { as: "authToken", from: "body.token" },
          { as: "userId", from: "body.user.id" },
          { as: "code", from: "status" },
          { as: "loc", from: "headers.location" },
        ],
        response,
      ),
    ).toEqual({ authToken: "abc", userId: "u1", code: 200, loc: "/orders/9" });
  });

  it("yields undefined for a missing path", () => {
    expect(extract([{ as: "x", from: "body.nope" }], response)).toEqual({ x: undefined });
  });

  it("returns an empty object for no extractors", () => {
    expect(extract([], response)).toEqual({});
  });
});
