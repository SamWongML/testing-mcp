import { errors } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import {
  assertScope,
  parseBearerToken,
  protectedResourceMetadata,
  PROTECTED_RESOURCE_PATH,
  SCOPES,
  ScopeError,
  wwwAuthenticate,
} from "./auth";
import { makeTestAuth, type TestAuth } from "./testkit";

/**
 * Auth core (research §15, ADR-007). The pure pieces — bearer parsing, scope checks, and the
 * RFC 9728 metadata — are unit-tested directly; token verification is exercised against a
 * locally-minted JWT so no authorization server is needed offline.
 */
describe("parseBearerToken", () => {
  it("extracts the token from a Bearer header", () => {
    expect(parseBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("is case-insensitive on the scheme", () => {
    expect(parseBearerToken("bearer xyz")).toBe("xyz");
  });

  it("returns null for a missing, empty, or non-Bearer header", () => {
    expect(parseBearerToken(undefined)).toBeNull();
    expect(parseBearerToken("")).toBeNull();
    expect(parseBearerToken("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearerToken("Bearer ")).toBeNull();
  });
});

describe("assertScope", () => {
  it("passes when the required scope is granted", () => {
    expect(() => assertScope([SCOPES.READ, SCOPES.RUN], SCOPES.RUN)).not.toThrow();
  });

  it("throws a ScopeError naming the missing scope", () => {
    try {
      assertScope([SCOPES.READ], SCOPES.RUN);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeError);
      expect((err as ScopeError).requiredScope).toBe(SCOPES.RUN);
      expect((err as ScopeError).message).toContain(SCOPES.RUN);
    }
  });

  it("throws when no scopes are granted at all", () => {
    expect(() => assertScope(undefined, SCOPES.READ)).toThrow(ScopeError);
    expect(() => assertScope([], SCOPES.READ)).toThrow(ScopeError);
  });
});

describe("protectedResourceMetadata", () => {
  it("emits an RFC 9728 document with the resource, issuer, and supported scopes", () => {
    const doc = protectedResourceMetadata({
      resource: "https://atp.example.com/mcp",
      issuer: "https://auth.example.com",
    });
    expect(doc.resource).toBe("https://atp.example.com/mcp");
    expect(doc.authorization_servers).toEqual(["https://auth.example.com"]);
    expect(doc.scopes_supported).toEqual([SCOPES.READ, SCOPES.RUN]);
    expect(doc.bearer_methods_supported).toContain("header");
  });
});

describe("wwwAuthenticate", () => {
  it("points at the protected-resource metadata URL (RFC 9728 challenge)", () => {
    const header = wwwAuthenticate("https://atp.example.com" + PROTECTED_RESOURCE_PATH);
    expect(header).toMatch(/^Bearer /);
    expect(header).toContain(
      `resource_metadata="https://atp.example.com${PROTECTED_RESOURCE_PATH}"`,
    );
  });
});

describe("createAuthenticator.verify", () => {
  let auth: TestAuth;
  beforeAll(async () => {
    auth = await makeTestAuth();
  });

  it("accepts a valid token and maps claims to AuthInfo", async () => {
    const token = await auth.mint({ scopes: [SCOPES.READ, SCOPES.RUN], clientId: "agent-7" });
    const info = await auth.authenticator.verify(token);
    expect(info.token).toBe(token);
    expect(info.clientId).toBe("agent-7");
    expect(info.scopes).toEqual([SCOPES.READ, SCOPES.RUN]);
    expect(info.resource?.toString()).toBe(auth.resource);
  });

  it("rejects a token signed by an unknown key", async () => {
    const other = await makeTestAuth();
    const token = await other.mint({ scopes: [SCOPES.READ] });
    await expect(auth.authenticator.verify(token)).rejects.toThrow();
  });

  it("rejects a token minted for a different resource (RFC 8707 audience)", async () => {
    const token = await auth.mint({ scopes: [SCOPES.READ], audience: "https://other.example/mcp" });
    await expect(auth.authenticator.verify(token)).rejects.toBeInstanceOf(
      errors.JWTClaimValidationFailed,
    );
  });

  it("rejects a token from a different issuer", async () => {
    const token = await auth.mint({ scopes: [SCOPES.READ], issuer: "https://evil.example" });
    await expect(auth.authenticator.verify(token)).rejects.toBeInstanceOf(
      errors.JWTClaimValidationFailed,
    );
  });

  it("rejects an expired token", async () => {
    const token = await auth.mint({ scopes: [SCOPES.READ], expired: true });
    await expect(auth.authenticator.verify(token)).rejects.toBeInstanceOf(errors.JWTExpired);
  });
});
