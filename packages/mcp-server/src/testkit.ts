import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { serve } from "@hono/node-server";
import { compile } from "@atp/compile";
import { createStore, LocalArtifactStore, migrate, type StoreClient } from "@atp/store";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";

import { createAuthenticator, SCOPES, type Authenticator } from "./auth";
import type { ServerContext } from "./context";
import { createHttpApp } from "./http";
import { buildMcpServer } from "./server";

/** The repo root, relative to this file, so the corpus compile is cwd-independent
 *  (mirrors the CLI tests — passes under both root `pnpm test` and per-package runs). */
export const repoRoot = resolve(__dirname, "../../..");

/**
 * The fixture corpus root — a corpus with *known, fixed* contents that the surface tests
 * assert against. `tests/` is a product artifact that grows as the platform is used; pinning
 * its ids here would make authoring a test a breaking change to the platform's own suite.
 * Its entries hit the same routes as {@link startTestSut}, so they are executable too.
 */
export const fixtureRoot = resolve(repoRoot, "fixtures/corpus");

/** Build a `ServerContext` over the fixture corpus with a throwaway local artifact
 *  store and no db (offline). Overrides let a test inject a db or swap the manifest. */
export async function makeTestContext(
  overrides: Partial<ServerContext> = {},
): Promise<ServerContext> {
  const manifest = await compile({ root: fixtureRoot });
  const dir = await mkdtemp(join(tmpdir(), "atp-mcp-"));
  return {
    manifest,
    sourceRoot: fixtureRoot,
    artifacts: new LocalArtifactStore(dir),
    artifactEnv: "test",
    secrets: {},
    ...overrides,
  };
}

export interface ConnectedClient {
  client: Client;
  close: () => Promise<void>;
}

/** Connect an in-process SDK `Client` to a fresh server over a linked in-memory transport
 *  pair — the canonical SDK test seam (no HTTP). */
export async function connectClient(ctx: ServerContext): Promise<ConnectedClient> {
  const server = buildMcpServer(ctx);
  const client = new Client({ name: "atp-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** Postgres is optional: the db-backed `list_runs`/history tests skip when it's absent,
 *  so `pnpm test` stays green offline (mirrors `@atp/store`'s own harness). */
export const pgAvailable = Boolean(process.env.ATP_TEST_DATABASE_URL);

/** A migrated, throwaway Postgres schema for one test, built from `@atp/store`'s public
 *  exports (no deep imports). `close()` drops the schema. */
export async function makeTestDb(): Promise<StoreClient> {
  const url = process.env.ATP_TEST_DATABASE_URL;
  if (!url) throw new Error("ATP_TEST_DATABASE_URL is not set");
  const namespace = `atp_mcp_test_${randomUUID().replace(/-/g, "")}`;
  const store = createStore({ connectionString: url, options: `-c search_path=${namespace}` });
  await store.pool.query(`CREATE SCHEMA "${namespace}"`);
  await migrate(store.pool);
  return {
    ...store,
    async close() {
      await store.pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await store.close();
    },
  };
}

/** Options for minting a test access token — defaults produce a valid token for `makeTestAuth`'s
 *  issuer/resource; overrides force the failure cases (wrong issuer/audience, expired). */
export interface MintOptions {
  scopes?: string[];
  clientId?: string;
  issuer?: string;
  audience?: string;
  expired?: boolean;
  /** Omit the `exp` claim entirely — a validly-signed token that would never expire unless the
   *  verifier explicitly requires the claim. */
  noExpiry?: boolean;
}

export interface TestAuth {
  /** Authenticator whose JWKS is the keypair `mint` signs with — verifies its own tokens. */
  authenticator: Authenticator;
  issuer: string;
  resource: string;
  mint: (opts?: MintOptions) => Promise<string>;
  /** Mint an HS256-signed token with otherwise-valid claims — the algorithm-confusion probe. */
  mintSymmetric: (opts?: MintOptions) => Promise<string>;
}

/**
 * A self-contained OAuth test fixture: an in-memory RS256 keypair, a local JWKS, an
 * {@link Authenticator} bound to that JWKS, and a `mint` that signs valid (or deliberately
 * invalid) access tokens. No authorization server or network — the offline seam for the
 * auth + scope-gating tests.
 */
export async function makeTestAuth(): Promise<TestAuth> {
  const issuer = "https://auth.test.atp";
  const resource = "https://atp.test/mcp";
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const kid = "test-key-1";
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
  const keys = createLocalJWKSet({ keys: [jwk] });
  const authenticator = createAuthenticator({ issuer, resource, keys });

  const mint = (opts: MintOptions = {}): Promise<string> => {
    const jwt = new SignJWT({ scope: (opts.scopes ?? [SCOPES.READ]).join(" ") })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject(opts.clientId ?? "test-client")
      .setIssuer(opts.issuer ?? issuer)
      .setAudience(opts.audience ?? resource)
      .setIssuedAt();
    if (!opts.noExpiry) jwt.setExpirationTime(opts.expired ? "-1m" : "5m");
    return jwt.sign(privateKey);
  };

  const mintSymmetric = (opts: MintOptions = {}): Promise<string> =>
    new SignJWT({ scope: (opts.scopes ?? [SCOPES.READ]).join(" ") })
      .setProtectedHeader({ alg: "HS256", kid })
      .setSubject(opts.clientId ?? "test-client")
      .setIssuer(opts.issuer ?? issuer)
      .setAudience(opts.audience ?? resource)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(new Uint8Array(32)); // any symmetric key — it must be rejected on `alg` alone

  return { authenticator, issuer, resource, mint, mintSymmetric };
}

export interface HttpHandle {
  url: string;
  close: () => Promise<void>;
}

/** Serve the HTTP app on an ephemeral loopback port for a real Streamable-HTTP round-trip. */
export function startHttpServer(ctx: ServerContext): Promise<HttpHandle> {
  const app = createHttpApp(ctx);
  return new Promise((res) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
      res({
        url: `http://127.0.0.1:${info.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

export interface TestSut {
  url: string;
  close: () => Promise<void>;
}

export interface TestSutOptions {
  /** When false, the ledger route never returns `settled`, so `billing.e2e-refund`'s
   *  polling `verify` node stays in flight — the deterministic window a cancel test needs. */
  ledgerSettles?: boolean;
}

/** A tiny mock SUT covering the routes the corpus tests + the `billing.e2e-refund` suite
 *  hit, so an inline `run_test` or a worker-run suite executes offline. Ephemeral loopback
 *  port; inject its URL as `{{env.baseUrl}}`. */
export function startTestSut(opts: TestSutOptions = {}): Promise<TestSut> {
  const ledgerSettles = opts.ledgerSettles ?? true;
  const server: Server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const method = req.method ?? "GET";
      const { pathname } = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const seg = pathname.split("/").filter(Boolean);
      if (method === "POST" && pathname === "/auth/login") {
        send(200, { token: "tok-abc123", user: { id: "user-1" }, expiresIn: 3600 });
      } else if (method === "GET" && seg[0] === "invoices") {
        send(200, { id: seg[1], amount: 4200, currency: "usd", status: "paid" });
      } else if (method === "POST" && pathname === "/orders") {
        send(201, { orderId: "order-1", paymentId: "pay-1" });
      } else if (method === "POST" && seg[0] === "payments" && seg[2] === "capture") {
        send(200, { paymentId: seg[1], status: "captured" });
      } else if (method === "POST" && seg[0] === "payments" && seg[2] === "refund") {
        send(202, { id: "refund-1", paymentId: seg[1], status: "pending" });
      } else if (method === "GET" && seg[0] === "ledger" && seg[1] === "refunds") {
        send(200, { refundId: seg[2], status: ledgerSettles ? "settled" : "pending" });
      } else {
        send(404, { error: `no route for ${method} ${pathname}` });
      }
    });
  });
  return new Promise((res) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      res({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
