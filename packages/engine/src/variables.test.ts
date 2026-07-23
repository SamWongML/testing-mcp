import { describe, expect, it } from "vitest";

import { createRunContext, resolveTemplates } from "./variables";

describe("resolveTemplates", () => {
  it("interpolates a template inside surrounding text", () => {
    const ctx = createRunContext({ env: { baseUrl: "https://api.example.com" } });
    expect(resolveTemplates("{{env.baseUrl}}/auth/login", ctx)).toBe(
      "https://api.example.com/auth/login",
    );
  });

  it("preserves the raw type for a whole-value template", () => {
    const ctx = createRunContext({ params: { count: 42, flag: false } });
    expect(resolveTemplates("{{params.count}}", ctx)).toBe(42);
    expect(resolveTemplates("{{params.flag}}", ctx)).toBe(false);
  });

  it("resolves nested paths and node vars", () => {
    const ctx = createRunContext({
      params: { user: { id: "u1" } },
      nodes: { auth: { authToken: "tok-123" } },
    });
    expect(resolveTemplates("{{params.user.id}}", ctx)).toBe("u1");
    expect(resolveTemplates("Bearer {{nodes.auth.authToken}}", ctx)).toBe("Bearer tok-123");
  });

  it("resolves recursively when a value is itself a template", () => {
    const ctx = createRunContext({
      params: { password: "{{secrets.QA_PASSWORD}}" },
      secrets: { QA_PASSWORD: "hunter2" },
    });
    expect(resolveTemplates("{{params.password}}", ctx)).toBe("hunter2");
  });

  it("walks objects and arrays deeply", () => {
    const ctx = createRunContext({
      env: { baseUrl: "https://x" },
      params: { email: "qa@example.com" },
    });
    expect(
      resolveTemplates(
        {
          url: "{{env.baseUrl}}/login",
          body: { email: "{{params.email}}", tags: ["{{params.email}}"] },
        },
        ctx,
      ),
    ).toEqual({
      url: "https://x/login",
      body: { email: "qa@example.com", tags: ["qa@example.com"] },
    });
  });

  it("throws on an unknown scope", () => {
    expect(() => resolveTemplates("{{bogus.x}}", createRunContext())).toThrow(
      /unknown template scope/,
    );
  });

  it("throws on an unresolved variable", () => {
    expect(() => resolveTemplates("{{env.missing}}", createRunContext())).toThrow(
      /unresolved template/,
    );
  });
});
