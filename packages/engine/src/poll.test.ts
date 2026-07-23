import { describe, expect, it } from "vitest";

import { withPoll } from "./poll";

const policy = (over: Partial<{ intervalMs: number; maxMs: number }> = {}) => ({
  untilAssertPasses: true as const,
  intervalMs: over.intervalMs ?? 5,
  maxMs: over.maxMs ?? 1000,
});

describe("withPoll", () => {
  it("runs once and returns when the first attempt already passes", async () => {
    let calls = 0;
    const result = await withPoll(policy(), async () => {
      calls++;
      return { result: calls, ok: true };
    });
    expect(calls).toBe(1);
    expect(result).toBe(1);
  });

  it("re-runs on the interval until an attempt passes", async () => {
    let calls = 0;
    const result = await withPoll(policy({ intervalMs: 5 }), async () => {
      calls++;
      return { result: calls, ok: calls >= 3 };
    });
    expect(calls).toBe(3);
    expect(result).toBe(3);
  });

  it("returns the last (failing) result once the maxMs budget is exhausted", async () => {
    let calls = 0;
    const started = Date.now();
    const result = await withPoll(policy({ intervalMs: 10, maxMs: 45 }), async () => {
      calls++;
      return { result: calls, ok: false };
    });
    // Never passes: polling stops when another interval would overrun the budget.
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(result).toBe(calls);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("stops waiting when the signal is aborted mid-interval", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    const promise = withPoll(
      policy({ intervalMs: 10_000, maxMs: 60_000 }),
      async () => {
        calls++;
        return { result: calls, ok: false };
      },
      { signal: controller.signal },
    );
    // First attempt has run and entered the long interval; aborting must unblock it.
    setTimeout(() => controller.abort(), 10);
    const result = await promise;
    expect(result).toBe(calls);
    expect(Date.now() - started).toBeLessThan(9_000);
  });
});
