import { describe, expect, it } from "vitest";

import { redactAuditParams } from "./guard";

/**
 * Audit-param redaction ("redact before persist", applied to the audit log). The engine's
 * `redact()` is *value*-based — it masks known secret values inside request/response snapshots —
 * so it cannot help here: a tool-call `params` bag is arbitrary caller input whose secrets are
 * identifiable only by key. The corpus's own `identity.login` declares a `password` param, so an
 * unredacted audit write would put a plaintext password in Postgres.
 */
describe("redactAuditParams", () => {
  it("masks secret-shaped keys while keeping the rest legible", () => {
    const out = redactAuditParams({
      email: "qa@example.com",
      password: "hunter2",
      apiKey: "k-123",
      access_token: "tok-abc",
      clientSecret: "shh",
      limit: 10,
    });
    expect(out).toEqual({
      email: "qa@example.com",
      password: "[REDACTED]",
      apiKey: "[REDACTED]",
      access_token: "[REDACTED]",
      clientSecret: "[REDACTED]",
      limit: 10,
    });
  });

  it("masks nested secrets, including inside arrays", () => {
    const out = redactAuditParams({
      user: { name: "qa", credentials: { password: "hunter2" } },
      accounts: [{ token: "t1" }, { token: "t2" }],
    });
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).not.toContain("t1");
    expect(JSON.stringify(out)).not.toContain("t2");
    expect((out as { user: { name: string } }).user.name).toBe("qa"); // non-secrets survive
  });

  it("is key-based, not value-based: an innocuous value under a secret key is still masked", () => {
    expect(redactAuditParams({ token: "public-info" })).toEqual({ token: "[REDACTED]" });
  });

  it("passes through undefined (no params supplied)", () => {
    expect(redactAuditParams(undefined)).toBeUndefined();
  });
});
