import type { PollPolicy } from "@atp/schema";

import { sleep } from "./util";

/**
 * Eventual-consistency polling (research §10.2–10.3). When a step declares
 * `poll.untilAssertPasses`, the runner re-sends the request and re-evaluates that
 * step's assertions on an `intervalMs` cadence until they pass or the `maxMs` budget
 * elapses — abortable via `signal`, exactly like the retry backoff.
 *
 * `poll` owns the *assertion* retry axis; transport re-tries stay with `withRetry`, so
 * the two compose cleanly: each individual send is bounded by the step timeout, the
 * whole poll loop by `maxMs`. A caller-cancel or run-timeout aborts the wait, and the
 * next attempt (with an aborted signal) surfaces the cancellation through the runner.
 */
export interface PollAttempt<T> {
  result: T;
  /** Assertions passed on this attempt → stop polling. */
  ok: boolean;
}

export async function withPoll<T>(
  policy: PollPolicy,
  run: () => Promise<PollAttempt<T>>,
  opts: { signal?: AbortSignal } = {},
): Promise<T> {
  const deadline = Date.now() + policy.maxMs;
  for (;;) {
    const { result, ok } = await run();
    // Stop on success, cancellation, or when another interval would overrun the budget.
    if (ok || opts.signal?.aborted || Date.now() + policy.intervalMs > deadline) {
      return result;
    }
    await sleep(policy.intervalMs, opts.signal);
  }
}
