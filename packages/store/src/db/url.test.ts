import { describe, expect, it } from "vitest";

import { resolveDatabaseUrl } from "./url";

describe("resolveDatabaseUrl", () => {
  it("prefers an explicit DATABASE_URL", () => {
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: "postgresql://atp:atp@localhost:5432/atp",
        DATABASE_SECRET: JSON.stringify({ host: "ignored" }),
      }),
    ).toBe("postgresql://atp:atp@localhost:5432/atp");
  });

  it("builds a URL from an RDS-managed secret", () => {
    // The exact JSON shape AWS Secrets Manager stores for an RDS instance credential.
    const secret = JSON.stringify({
      username: "atp",
      password: "s3cret",
      host: "atp.abc123.us-east-1.rds.amazonaws.com",
      port: 5432,
      dbname: "atp",
      engine: "postgres",
    });
    expect(resolveDatabaseUrl({ DATABASE_SECRET: secret })).toBe(
      "postgresql://atp:s3cret@atp.abc123.us-east-1.rds.amazonaws.com:5432/atp",
    );
  });

  it("percent-encodes credentials so a generated password cannot corrupt the URL", () => {
    // RDS-generated passwords contain punctuation; `#` would otherwise truncate the URL at
    // a fragment and `/` would look like a path — a silent connect-to-the-wrong-place bug.
    const secret = JSON.stringify({
      username: "at/p",
      password: "p#a s/s?w:d",
      host: "db.internal",
      port: 5432,
      dbname: "atp",
    });
    const url = resolveDatabaseUrl({ DATABASE_SECRET: secret });
    expect(url).toBe("postgresql://at%2Fp:p%23a%20s%2Fs%3Fw%3Ad@db.internal:5432/atp");
    // The round-trip is what actually matters: `pg` must recover the original password.
    expect(decodeURIComponent(new URL(url!).password)).toBe("p#a s/s?w:d");
  });

  it("returns undefined when neither is configured (the offline/dev path)", () => {
    expect(resolveDatabaseUrl({})).toBeUndefined();
  });

  it("fails fast on a malformed secret rather than connecting somewhere wrong", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_SECRET: "not json" })).toThrow(/DATABASE_SECRET/);
    expect(() => resolveDatabaseUrl({ DATABASE_SECRET: JSON.stringify({ host: "h" }) })).toThrow(
      /DATABASE_SECRET/,
    );
  });
});
