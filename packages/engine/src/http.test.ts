import { MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sendRequest } from "./http";

let agent: MockAgent;

beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  setGlobalDispatcher(agent);
});

afterEach(async () => {
  await agent.close();
});

describe("sendRequest", () => {
  it("sends a JSON body, parses a JSON response and captures timing", async () => {
    const pool = agent.get("https://api.example.com");
    pool
      .intercept({ path: "/auth/login", method: "POST" })
      .reply(200, { token: "abc" }, { headers: { "content-type": "application/json" } });

    const res = await sendRequest({
      method: "POST",
      url: "https://api.example.com/auth/login",
      body: { email: "qa@example.com" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ token: "abc" });
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.timingMs).toBeGreaterThanOrEqual(0);
  });

  it("appends query parameters to the URL", async () => {
    const pool = agent.get("https://api.example.com");
    pool.intercept({ path: "/search", method: "GET", query: { q: "hi" } }).reply(200, "ok");

    const res = await sendRequest({
      method: "GET",
      url: "https://api.example.com/search",
      query: { q: "hi" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toBe("ok");
  });

  it("aborts when the per-step timeout fires", async () => {
    const pool = agent.get("https://api.example.com");
    pool.intercept({ path: "/slow", method: "GET" }).reply(200, "late").delay(50);

    await expect(
      sendRequest({ method: "GET", url: "https://api.example.com/slow" }, { timeoutMs: 5 }),
    ).rejects.toThrow();
  });
});
