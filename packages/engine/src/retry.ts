import type { RetryOn, RetryPolicy } from "@atp/schema";

import { sleep } from "./util";

/**
 * Per-step retry (research §10.2/§10.3). The caller runs one attempt and reports
 * which retryable conditions it hit (`network`, `4xx`, `5xx`, `assertion`);
 * `withRetry` re-runs while an attempt remains and at least one reported condition
 * is in the policy's `on` list, honoring `backoffMs` and cooperative cancellation.
 */

export interface Attempt<T> {
  result: T;
  /** Retryable conditions this attempt hit — empty means "final, do not retry". */
  retryOn: RetryOn[];
}

export async function withRetry<T>(
  policy: RetryPolicy | undefined,
  run: (attempt: number) => Promise<Attempt<T>>,
  opts: { signal?: AbortSignal } = {},
): Promise<{ result: T; attempts: number }> {
  const max = policy?.max ?? 0;
  const on = policy?.on ?? [];
  const backoffMs = policy?.backoffMs ?? 0;

  for (let attempt = 1; ; attempt++) {
    const { result, retryOn } = await run(attempt);
    const shouldRetry = attempt <= max && retryOn.some((r) => on.includes(r));
    if (!shouldRetry || opts.signal?.aborted) {
      return { result, attempts: attempt };
    }
    if (backoffMs > 0) await sleep(backoffMs, opts.signal);
  }
}
