/**
 * Postgres connection-string resolution (P11). On ECS the database credential arrives as the
 * RDS-managed **Secrets Manager JSON blob** injected whole into the task, not as a ready-made
 * URL — assembling it here (rather than in a shell entrypoint) keeps the credential handling
 * typed, testable, and correctly percent-encoded, and leaves the app's config surface as the
 * single `DATABASE_URL` every other phase already consumes.
 */

/** The shape RDS writes into Secrets Manager for an instance credential. */
interface RdsSecret {
  username: string;
  password: string;
  host: string;
  port: number | string;
  dbname?: string;
  engine?: string;
}

export interface DatabaseUrlConfig {
  DATABASE_URL?: string;
  /** The raw Secrets Manager JSON, injected by the ECS task definition. */
  DATABASE_SECRET?: string;
}

function parseSecret(raw: string): RdsSecret {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("DATABASE_SECRET is not valid JSON");
  }
  const s = parsed as Partial<RdsSecret>;
  if (!s || typeof s.username !== "string" || typeof s.password !== "string") {
    throw new Error("DATABASE_SECRET must carry `username` and `password`");
  }
  if (typeof s.host !== "string" || s.port === undefined) {
    throw new Error("DATABASE_SECRET must carry `host` and `port`");
  }
  return {
    username: s.username,
    password: s.password,
    host: s.host,
    port: s.port,
    dbname: s.dbname,
  };
}

/**
 * Resolve the connection string, preferring an explicit `DATABASE_URL` (dev, CI, and any
 * deployment that manages its own secret) and otherwise deriving one from the RDS secret.
 * Returns `undefined` when neither is set — the offline path, where the server runs
 * synchronous-only and the worker fails fast.
 */
export function resolveDatabaseUrl(config: DatabaseUrlConfig): string | undefined {
  if (config.DATABASE_URL) return config.DATABASE_URL;
  if (!config.DATABASE_SECRET) return undefined;

  const { username, password, host, port, dbname } = parseSecret(config.DATABASE_SECRET);
  // Generated passwords contain punctuation that is structural in a URL (`#`, `/`, `?`, `:`),
  // so both credentials are percent-encoded rather than trusted to be URL-safe.
  const user = encodeURIComponent(username);
  const pass = encodeURIComponent(password);
  return `postgresql://${user}:${pass}@${host}:${port}/${dbname ?? "atp"}`;
}
