import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny local mock SUT (system under test) so the sample corpus runs offline via
 * `atp run` (research §P4). It is not a real API — just enough deterministic routes to
 * exercise `identity.login`, `billing.get-invoice`, and the `billing.e2e-refund` chain.
 * Built on `node:http` (no framework dependency); each instance binds an ephemeral
 * loopback port so tests and CLI runs never collide.
 */

export interface MockSut {
  /** Base URL, e.g. `http://127.0.0.1:53412` — inject as `{{env.baseUrl}}`. */
  url: string;
  /** Stop the server and release the port. */
  close: () => Promise<void>;
}

interface Reply {
  status: number;
  body: unknown;
}
type Handler = (params: Record<string, string>) => Reply;

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

const routes: Route[] = [
  route("POST", "/auth/login", () => ({
    status: 200,
    body: { token: "tok-abc123", user: { id: "user-1" }, expiresIn: 3600 },
  })),
  route("POST", "/orders", () => ({
    status: 201,
    body: { orderId: "order-1", paymentId: "pay-1" },
  })),
  route("POST", "/payments/:id/capture", (p) => ({
    status: 200,
    body: { paymentId: p.id, status: "captured" },
  })),
  route("POST", "/payments/:id/refund", (p) => ({
    status: 202,
    body: { id: "refund-1", paymentId: p.id, status: "pending" },
  })),
  route("GET", "/ledger/refunds/:id", (p) => ({
    status: 200,
    body: { refundId: p.id, status: "settled" },
  })),
  route("GET", "/invoices/:id", (p) => ({
    status: 200,
    body: { id: p.id, amount: 4200, currency: "usd", status: "paid" },
  })),
];

function handle(method: string, pathname: string): Reply {
  const actual = pathname.split("/").filter(Boolean);
  for (const r of routes) {
    if (r.method !== method) continue;
    const params = matchPath(r.segments, actual);
    if (params) return r.handler(params);
  }
  return { status: 404, body: { error: `no route for ${method} ${pathname}` } };
}

/** Start the mock SUT on `port` (0 = ephemeral, the default). */
export function startMockSut(port = 0): Promise<MockSut> {
  const server: Server = createServer((req, res) => {
    // The mock is deterministic per route, so the request body is drained (to free the
    // socket) but not inspected.
    req.resume();
    req.on("end", () => {
      const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      const reply = handle(req.method ?? "GET", pathname);
      res.writeHead(reply.status, { "content-type": "application/json" });
      res.end(JSON.stringify(reply.body));
    });
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
