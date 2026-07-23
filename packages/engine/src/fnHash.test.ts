import { describe, expect, it } from "vitest";

import { hashFn } from "./fnHash";

describe("hashFn", () => {
  it("prefixes a sha256 hex digest", () => {
    expect(hashFn(() => true)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("is stable for identical source and differs otherwise", () => {
    const a = (res: { ok: boolean }) => res.ok;
    const b = (res: { ok: boolean }) => res.ok;
    const c = (res: { ok: boolean }) => !res.ok;
    expect(hashFn(a)).toBe(hashFn(b));
    expect(hashFn(a)).not.toBe(hashFn(c));
  });
});
