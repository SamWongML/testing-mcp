/**
 * Mockmart — a stand-in system under test for the `fixtures/insomnia/mockmart.insomnia.yaml`
 * collection and the `tests/mockmart/` corpus migrated from it.
 *
 * This is a *fixture service*, not a real API: it answers deterministically so a migrated
 * corpus can be exercised end to end offline (`atp golden`, `atp run`, `run_test` over MCP).
 * It is deliberately richer than `packages/cli/src/mock-sut.ts` — that mock backs the sample
 * corpus and is started implicitly by `atp run`; this one is an explicit, addressable service
 * you point `--base-url` at, so golden capture has a real HTTP peer to record.
 *
 * Every capability the corpus covers has a route that can genuinely fail it:
 * - credentials are checked (bearer · basic · apiKey header · apiKey query · oauth2), so a
 *   wrong or missing one is a real 401, not a decorative header,
 * - `GET /inventory/:sku` 503s twice per sku before succeeding (retry),
 * - `GET /shipments/:orderId` reports `in_transit` twice before `delivered` (poll),
 * - `GET /catalog/search` varies currency/discount by region+tier (matrix),
 * - an unknown cart/product id 404s — which is what an unwired `__TODO_CHAIN__` hits.
 *
 * Both stateful behaviours are keyed per id and reset when the process restarts, so a fresh
 * start always reproduces the same sequence.
 *
 *   pnpm exec tsx fixtures/sut/mockmart-sut.ts --port 8899
 *
 * Expected credentials come from the same `ATP_SECRET_*` bag the engine fills `{{secrets.*}}`
 * from, so one export block configures the service and the runs against it. The fallbacks are
 * dev literals for a throwaway local service — they are not credentials to anything.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const secret = (key: string, fallback: string): string => process.env[`ATP_SECRET_${key}`] ?? fallback;

const API_TOKEN = secret("API_TOKEN", "shopper-token-3f9a");
const ADMIN_TOKEN = secret("ADMIN_TOKEN", "admin-token-77b2");
const SEARCH_KEY = secret("SEARCH_KEY", "search-key-c410");
const FEATURED_KEY = secret("FEATURED_KEY", "featured-key-2d61");
const LEGACY_PASSWORD = secret("LEGACY_PASSWORD", "legacy-pass-d88e");
const OAUTH_CLIENT_SECRET = secret("OAUTH_CLIENT_SECRET", "oauth-secret-91ac");
const QA_PASSWORD = secret("QA_PASSWORD", "qa-password");

const LEGACY_USER = "qa-bot";
const OAUTH_CLIENT_ID = "reporting-bot";
/** The only product ids that exist — anything else 404s (an honest not-found path). */
const CATALOG = new Set(["sku-1001", "sku-1002", "sku-1003"]);

interface Reply {
  status: number;
  /** JSON body. Omit for an empty response (204, HEAD). */
  body?: unknown;
  /** Extra response headers, e.g. `allow` on OPTIONS. */
  headers?: Record<string, string>;
  /** Plain-text body, sent as `text/plain` instead of JSON. */
  text?: string;
}

interface Req {
  method: string;
  params: Record<string, string>;
  query: URLSearchParams;
  headers: Record<string, string>;
  /** Parsed JSON body, the raw string when it isn't JSON, or undefined when empty. */
  body: unknown;
  raw: string;
}

type Handler = (req: Req) => Reply | Promise<Reply>;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  return { method, segments: path.split("/").filter(Boolean), handler };
}

/** Match a request path against a route template, capturing `:param` segments. */
function matchPath(template: string[], actual: string[]): Record<string, string> | null {
  if (template.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < template.length; i++) {
    const t = template[i] as string;
    const a = actual[i] as string;
    if (t.startsWith(":")) params[t.slice(1)] = decodeURIComponent(a);
    else if (t !== a) return null;
  }
  return params;
}

// --- credential checks -------------------------------------------------------------------

const UNAUTHORIZED: Reply = {
  status: 401,
  body: { error: "unauthorized", detail: "missing or invalid credentials" },
  headers: { "www-authenticate": "Bearer" },
};

function bearer(req: Req): string | undefined {
  const value = req.headers.authorization ?? "";
  return value.toLowerCase().startsWith("bearer ") ? value.slice(7).trim() : undefined;
}

/** Tokens minted by `POST /oauth/token`, so `/reports/daily` accepts only a real grant. */
const issuedOauthTokens = new Set<string>();

function requireBearer(req: Req, expected: string): Reply | undefined {
  return bearer(req) === expected ? undefined : UNAUTHORIZED;
}

function requireBasic(req: Req): Reply | undefined {
  const value = req.headers.authorization ?? "";
  if (!value.toLowerCase().startsWith("basic ")) return UNAUTHORIZED;
  const decoded = Buffer.from(value.slice(6).trim(), "base64").toString("utf8");
  return decoded === `${LEGACY_USER}:${LEGACY_PASSWORD}` ? undefined : UNAUTHORIZED;
}

function requireApiKey(
  req: Req,
  where: "header" | "query",
  name: string,
  expected: string,
): Reply | undefined {
  const actual = where === "header" ? req.headers[name] : req.query.get(name);
  return actual === expected ? undefined : UNAUTHORIZED;
}

// --- stateful behaviours (reset per process) ---------------------------------------------

/** `GET /inventory/:sku` 503s this many times per sku before succeeding — the retry axis. */
const WARMUP_FAILURES = 2;
const inventoryAttempts = new Map<string, number>();

/** `GET /shipments/:orderId` reports `in_transit` this many times first — the poll axis. */
const TRANSIT_POLLS = 2;
const shipmentPolls = new Map<string, number>();

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${String(++counter).padStart(4, "0")}`;
/** Live carts, so an unknown (or unwired) cart id 404s rather than being invented. */
const carts = new Map<string, { itemCount: number; subtotalCents: number }>();

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// --- routes ------------------------------------------------------------------------------

const routes: Route[] = [
  // Health / metadata — no credentials.
  route("GET", "/health", (req) => ({
    status: 200,
    body: {
      status: "ok",
      version: "1.4.2",
      region: req.query.get("region") ?? "us",
      checks: { db: "ok", queue: "ok" },
    },
  })),
  route("HEAD", "/health", () => ({ status: 200, headers: { "x-sut": "mockmart" } })),
  route("OPTIONS", "/orders", () => ({
    status: 204,
    headers: { allow: "GET, POST, PATCH, DELETE, OPTIONS" },
  })),

  // Credential issuers.
  route("POST", "/auth/login", (req) => {
    const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
    if (!email || password !== QA_PASSWORD) {
      return { status: 401, body: { error: "invalid_credentials" } };
    }
    return {
      status: 200,
      body: {
        token: `session-${Buffer.from(email).toString("base64url").slice(0, 12)}`,
        refreshToken: "refresh-8fc1",
        expiresIn: 3600,
        user: { id: "usr-4410", email, role: "qa" },
      },
    };
  }),
  route("POST", "/oauth/token", (req) => {
    const form = new URLSearchParams(typeof req.raw === "string" ? req.raw : "");
    const ok =
      form.get("grant_type") === "client_credentials" &&
      form.get("client_id") === OAUTH_CLIENT_ID &&
      form.get("client_secret") === OAUTH_CLIENT_SECRET;
    if (!ok) return { status: 401, body: { error: "invalid_client" } };
    const token = `oauth-${nextId("tok")}`;
    issuedOauthTokens.add(token);
    return {
      status: 200,
      body: {
        access_token: token,
        token_type: "Bearer",
        expires_in: 900,
        scope: form.get("scope") ?? "reports:read",
      },
    };
  }),

  // Catalog — bearer, apiKey (header), apiKey (query).
  route("GET", "/catalog/products/:id", (req) => {
    const denied = requireBearer(req, API_TOKEN);
    if (denied) return denied;
    const id = req.params.id as string;
    if (!CATALOG.has(id)) {
      return { status: 404, body: { error: "product_not_found", productId: id } };
    }
    return {
      status: 200,
      body: {
        id,
        sku: id,
        name: `Mockmart widget ${id.slice(-4)}`,
        priceCents: 4200,
        currency: "usd",
        rating: 4.6,
        inStock: true,
        tags: ["widget", "featured"],
        warehouse: { code: "eu-west-1", shelf: "B12" },
      },
    };
  }),
  route("GET", "/catalog/search", (req) => {
    const denied = requireApiKey(req, "header", "x-api-key", SEARCH_KEY);
    if (denied) return denied;
    const region = req.query.get("region") ?? "us";
    const tier = req.query.get("tier") ?? "free";
    const currency = region === "eu" ? "eur" : "usd";
    const discountPct = tier === "pro" ? 10 : 0;
    const results = [...CATALOG].map((sku, i) => ({
      id: sku,
      name: `Mockmart widget ${sku.slice(-4)}`,
      priceCents: 4200 + i * 250,
      currency,
    }));
    return {
      status: 200,
      body: {
        query: req.query.get("q") ?? "",
        region,
        tier,
        currency,
        discountPct,
        total: results.length,
        results,
      },
    };
  }),
  route("GET", "/catalog/featured", (req) => {
    const denied = requireApiKey(req, "query", "api_key", FEATURED_KEY);
    if (denied) return denied;
    return {
      status: 200,
      body: {
        count: 2,
        items: [
          { id: "sku-1001", name: "Mockmart widget 1001", priceCents: 4200 },
          { id: "sku-1003", name: "Mockmart widget 1003", priceCents: 4700 },
        ],
      },
    };
  }),

  // Orders — admin bearer, and the method surface (POST/GET/PATCH/PUT/DELETE).
  route("POST", "/orders", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    const { sku = "sku-1001", quantity = 1 } = (req.body ?? {}) as {
      sku?: string;
      quantity?: number;
    };
    return {
      status: 201,
      body: {
        orderId: nextId("ord"),
        paymentId: nextId("pay"),
        status: "pending",
        sku,
        quantity,
        totalCents: 4200 * quantity,
        currency: "usd",
      },
    };
  }),
  route("GET", "/orders/:id", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    return {
      status: 200,
      body: {
        orderId: req.params.id,
        status: "pending",
        totalCents: 4200,
        currency: "usd",
        items: [{ sku: "sku-1001", quantity: 1 }],
      },
    };
  }),
  route("PATCH", "/orders/:id", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    const { status = "confirmed" } = (req.body ?? {}) as { status?: string };
    return { status: 200, body: { orderId: req.params.id, status, updated: true } };
  }),
  route("PUT", "/orders/:id/address", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    const address = (req.body ?? {}) as Record<string, unknown>;
    return { status: 200, body: { orderId: req.params.id, address, updated: true } };
  }),
  route("DELETE", "/orders/:id", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    return { status: 204 };
  }),

  // Checkout chain — the suite's DAG.
  route("POST", "/carts", (req) => {
    const denied = requireBearer(req, API_TOKEN);
    if (denied) return denied;
    const cartId = nextId("cart");
    carts.set(cartId, { itemCount: 0, subtotalCents: 0 });
    return { status: 201, body: { cartId, itemCount: 0, currency: "usd" } };
  }),
  route("POST", "/carts/:cartId/items", (req) => {
    const denied = requireBearer(req, API_TOKEN);
    if (denied) return denied;
    const cartId = req.params.cartId as string;
    const cart = carts.get(cartId);
    if (!cart) return { status: 404, body: { error: "cart_not_found", cartId } };
    const { quantity = 1 } = (req.body ?? {}) as { quantity?: number };
    cart.itemCount += quantity;
    cart.subtotalCents += 4200 * quantity;
    return {
      status: 200,
      body: { cartId, itemCount: cart.itemCount, subtotalCents: cart.subtotalCents },
    };
  }),
  route("POST", "/carts/:cartId/checkout", (req) => {
    const denied = requireBearer(req, API_TOKEN);
    if (denied) return denied;
    const cartId = req.params.cartId as string;
    const cart = carts.get(cartId);
    if (!cart) return { status: 404, body: { error: "cart_not_found", cartId } };
    return {
      status: 201,
      body: {
        orderId: nextId("ord"),
        paymentId: nextId("pay"),
        status: "authorized",
        amountCents: cart.subtotalCents,
        currency: "usd",
      },
    };
  }),
  route("POST", "/payments/:paymentId/capture", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    return {
      status: 200,
      body: { paymentId: req.params.paymentId, status: "captured", capturedCents: 4200 },
    };
  }),
  route("GET", "/shipments/:orderId", (req) => {
    const denied = requireBearer(req, ADMIN_TOKEN);
    if (denied) return denied;
    const orderId = req.params.orderId as string;
    const seen = (shipmentPolls.get(orderId) ?? 0) + 1;
    shipmentPolls.set(orderId, seen);
    const delivered = seen > TRANSIT_POLLS;
    return {
      status: 200,
      body: {
        orderId,
        shipmentId: `shp-${orderId.slice(-4)}`,
        status: delivered ? "delivered" : "in_transit",
        carrier: "mockmart-express",
        polls: seen,
      },
    };
  }),

  // Flaky inventory — 503 twice per sku, then 200 (the retry axis).
  route("GET", "/inventory/:sku", (req) => {
    const denied = requireBearer(req, API_TOKEN);
    if (denied) return denied;
    const sku = req.params.sku as string;
    const seen = (inventoryAttempts.get(sku) ?? 0) + 1;
    inventoryAttempts.set(sku, seen);
    if (seen <= WARMUP_FAILURES) {
      return { status: 503, body: { error: "warming_up", attempt: seen } };
    }
    return {
      status: 200,
      body: { sku, available: 42, reserved: 3, warehouse: "eu-west-1", attempt: seen },
    };
  }),

  // Reporting — only a token minted by the client-credentials grant is accepted.
  route("GET", "/reports/daily", (req) => {
    const token = bearer(req);
    if (!token || !issuedOauthTokens.has(token)) return UNAUTHORIZED;
    return {
      status: 200,
      body: { date: "2026-07-26", orders: 128, revenueCents: 537600, currency: "usd" },
    };
  }),

  // Legacy — basic auth, and the only non-JSON response body.
  route("GET", "/legacy/ping", (req) => {
    const denied = requireBasic(req);
    if (denied) return denied;
    return { status: 200, text: "pong" };
  }),

  // Deliberately slow, so a step timeout has something real to bound.
  route("GET", "/slow", async (req) => {
    const ms = Math.min(Number(req.query.get("ms") ?? 250), 5_000);
    await sleep(ms);
    return { status: 200, body: { sleptMs: ms, status: "ok" } };
  }),
];

async function dispatch(req: Req, pathname: string): Promise<Reply> {
  const actual = pathname.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const params = matchPath(r.segments, actual);
    if (params) return r.handler({ ...req, params });
  }
  return { status: 404, body: { error: "no_route", detail: `${req.method} ${pathname}` } };
}

function readBody(message: IncomingMessage): Promise<string> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    message.on("data", (c: Buffer) => chunks.push(c));
    message.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (raw.length === 0) return undefined;
  if (contentType?.includes("json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return raw;
}

function headerMap(message: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(message.headers)) {
    if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export interface MockmartSut {
  url: string;
  close: () => Promise<void>;
}

/** Start Mockmart on `port` (0 = ephemeral). */
export function startMockmart(port = 0): Promise<MockmartSut> {
  const server: Server = createServer((message, res) => {
    void (async () => {
      const url = new URL(message.url ?? "/", "http://127.0.0.1");
      const raw = await readBody(message);
      const headers = headerMap(message);
      const reply = await dispatch(
        {
          method: message.method ?? "GET",
          params: {},
          query: url.searchParams,
          headers,
          body: parseBody(raw, headers["content-type"]),
          raw,
        },
        url.pathname,
      );

      const isJson = reply.text === undefined && reply.body !== undefined;
      const payload = isJson ? JSON.stringify(reply.body) : (reply.text ?? "");
      res.writeHead(reply.status, {
        ...(payload.length > 0
          ? { "content-type": isJson ? "application/json" : "text/plain; charset=utf-8" }
          : {}),
        ...reply.headers,
      });
      // A HEAD response carries headers only; writing a body would be a protocol error.
      res.end(message.method === "HEAD" ? undefined : payload);
    })();
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const { port: bound } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${bound}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

// Run directly (`tsx fixtures/sut/mockmart-sut.ts --port 8899`) rather than imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  const flag = process.argv.indexOf("--port");
  const port = Number(flag >= 0 ? process.argv[flag + 1] : (process.env.PORT ?? 8899));
  void startMockmart(port).then((sut) => {
    console.log(`mockmart SUT listening on ${sut.url}`);
  });
}
