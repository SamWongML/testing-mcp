import { describe, expect, it } from "vitest";

import { loadConfig } from "./config";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe("development");
    expect(config.PORT).toBe(3000);
    expect(config.MODE).toBeUndefined();
  });

  it("coerces PORT and reads later-phase fields", () => {
    const config = loadConfig({
      MODE: "server",
      PORT: "8080",
      DATABASE_URL: "postgres://localhost/atp",
      S3_BUCKET: "atp-artifacts",
    });
    expect(config.MODE).toBe("server");
    expect(config.PORT).toBe(8080);
    expect(config.DATABASE_URL).toBe("postgres://localhost/atp");
  });

  it("fails fast on an invalid MODE", () => {
    expect(() => loadConfig({ MODE: "orchestrator" })).toThrow();
  });

  it("fails fast on a non-numeric PORT", () => {
    expect(() => loadConfig({ PORT: "not-a-port" })).toThrow();
  });

  it("defaults auth and observability off (dev-off flags)", () => {
    const config = loadConfig({});
    expect(config.AUTH_ENABLED).toBe(false);
    expect(config.OTEL_ENABLED).toBe(false);
    expect(config.SERVICE_NAME).toBe("atp");
    expect(config.AUTH_ISSUER).toBeUndefined();
    expect(config.AUTH_JWKS_URI).toBeUndefined();
    expect(config.AUTH_RESOURCE).toBeUndefined();
  });

  it("reads the auth + observability fields, coercing boolean flags", () => {
    const config = loadConfig({
      AUTH_ENABLED: "true",
      AUTH_ISSUER: "https://auth.example.com",
      AUTH_JWKS_URI: "https://auth.example.com/.well-known/jwks.json",
      AUTH_RESOURCE: "https://atp.example.com/mcp",
      OTEL_ENABLED: "true",
      SERVICE_NAME: "atp-worker",
    });
    expect(config.AUTH_ENABLED).toBe(true);
    expect(config.AUTH_ISSUER).toBe("https://auth.example.com");
    expect(config.AUTH_JWKS_URI).toBe("https://auth.example.com/.well-known/jwks.json");
    expect(config.AUTH_RESOURCE).toBe("https://atp.example.com/mcp");
    expect(config.OTEL_ENABLED).toBe(true);
    expect(config.SERVICE_NAME).toBe("atp-worker");
  });

  it("fails fast on a non-boolean AUTH_ENABLED", () => {
    expect(() => loadConfig({ AUTH_ENABLED: "maybe" })).toThrow();
  });
});
