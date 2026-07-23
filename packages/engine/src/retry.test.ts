import { describe, expect, it } from "vitest";

import { withRetry } from "./retry";

describe("withRetry", () => {
  it("runs once when no policy is given", async () => {
    let calls = 0;
    const { result, attempts } = await withRetry(undefined, async () => {
      calls++;
      return { result: "ok", retryOn: ["5xx"] };
    });
    expect(calls).toBe(1);
    expect(attempts).toBe(1);
    expect(result).toBe("ok");
  });

  it("retries up to max while a reported condition is in the policy", async () => {
    let calls = 0;
    const { attempts } = await withRetry({ max: 2, backoffMs: 0, on: ["5xx"] }, async () => {
      calls++;
      return { result: calls, retryOn: ["5xx"] };
    });
    expect(calls).toBe(3); // 1 initial + 2 retries
    expect(attempts).toBe(3);
  });

  it("stops early once an attempt reports no retryable condition", async () => {
    let calls = 0;
    const { attempts } = await withRetry({ max: 5, backoffMs: 0, on: ["5xx"] }, async () => {
      calls++;
      return { result: calls, retryOn: calls >= 2 ? [] : ["5xx"] };
    });
    expect(calls).toBe(2);
    expect(attempts).toBe(2);
  });

  it("does not retry conditions outside the policy's on-list", async () => {
    let calls = 0;
    await withRetry({ max: 3, backoffMs: 0, on: ["network"] }, async () => {
      calls++;
      return { result: calls, retryOn: ["assertion"] };
    });
    expect(calls).toBe(1);
  });

  it("stops retrying once the signal is aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const { attempts } = await withRetry(
      { max: 5, backoffMs: 0, on: ["5xx"] },
      async () => {
        calls++;
        controller.abort();
        return { result: calls, retryOn: ["5xx"] };
      },
      { signal: controller.signal },
    );
    expect(calls).toBe(1);
    expect(attempts).toBe(1);
  });

  it("interrupts the backoff sleep when aborted mid-wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const started = Date.now();
    const promise = withRetry(
      { max: 5, backoffMs: 10_000, on: ["5xx"] },
      async () => {
        calls++;
        return { result: calls, retryOn: ["5xx"] };
      },
      { signal: controller.signal },
    );
    // First attempt has run and entered the 10s backoff; aborting must unblock it.
    setTimeout(() => controller.abort(), 10);
    const { attempts } = await promise;
    expect(attempts).toBe(2); // the wake-from-sleep runs one more attempt, then stops (aborted)
    expect(Date.now() - started).toBeLessThan(9_000);
  });
});
