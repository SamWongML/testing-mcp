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
});
