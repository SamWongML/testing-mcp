import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  insufficientScopeChallenge,
  parseBearerToken,
  PROTECTED_RESOURCE_PATH,
  protectedResourceMetadata,
  requiredScopesFor,
  wwwAuthenticate,
} from "./auth";
import type { ServerContext } from "./context";
import { buildMcpServer } from "./server";
import { withSpan } from "./telemetry";

/**
 * The HTTP surface (research §8, §15, ADR-002/007). MCP is served at `/mcp` over the
 * Streamable-HTTP transport in **stateless** mode: a fresh server + transport is built per
 * request and discarded, so no session state crosses requests. `/healthz` is liveness;
 * `/readyz` is readiness (the manifest loaded).
 *
 * When `ctx.authn` is set the surface is OAuth-gated: `/mcp` requires a valid bearer token
 * (else 401 with an RFC 9728 `WWW-Authenticate` challenge), the validated {@link AuthInfo} is
 * threaded into the request handlers (which enforce scope), and the protected-resource metadata
 * is advertised at {@link PROTECTED_RESOURCE_PATH}. When `ctx.telemetry` is set each `/mcp`
 * request is wrapped in a span so the run trace starts at the MCP call.
 */
export function createHttpApp(ctx: ServerContext): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Content-Type", "mcp-session-id", "Last-Event-ID", "mcp-protocol-version"],
      exposeHeaders: ["mcp-session-id", "mcp-protocol-version"],
    }),
  );

  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.get("/readyz", (c) => c.json({ status: "ready", tests: ctx.manifest.entries.length }));

  const authn = ctx.authn;
  if (authn) {
    // RFC 9728 protected-resource metadata: how clients discover the authorization server.
    app.get(PROTECTED_RESOURCE_PATH, (c) =>
      c.json(protectedResourceMetadata({ resource: authn.resource, issuer: authn.issuer })),
    );
  }

  app.all("/mcp", async (c) => {
    let authInfo: AuthInfo | undefined;
    // Reading the body here consumes the request stream, so whatever we parse must be handed to
    // the transport as `parsedBody` rather than re-read.
    let parsedBody: unknown;
    let bodyParsed = false;

    if (authn) {
      const metadataUrl = new URL(PROTECTED_RESOURCE_PATH, c.req.url).toString();
      const challenge = (): Response =>
        new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": wwwAuthenticate(metadataUrl) },
        });

      const token = parseBearerToken(c.req.header("authorization"));
      if (!token) return challenge();
      try {
        authInfo = await authn.authenticator.verify(token);
      } catch {
        return challenge();
      }

      // Authorize the JSON-RPC methods the SDK handles generically (the `tasks/*` family), which
      // never reach a scope-guarded tool handler. Everything else is gated in its own handler.
      if (c.req.method === "POST") {
        try {
          parsedBody = await c.req.json();
        } catch {
          return new Response("Bad Request", { status: 400 });
        }
        bodyParsed = true;
        for (const scope of requiredScopesFor(parsedBody)) {
          if (!authInfo.scopes.includes(scope)) {
            return new Response("Forbidden", {
              status: 403,
              headers: { "WWW-Authenticate": insufficientScopeChallenge(scope) },
            });
          }
        }
      }
    }

    const handle = async (): Promise<Response> => {
      const server = buildMcpServer(ctx);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await server.connect(transport);
      return transport.handleRequest(
        c.req.raw,
        bodyParsed ? { authInfo, parsedBody } : { authInfo },
      );
    };

    if (ctx.telemetry) {
      return withSpan(ctx.telemetry.tracer, `mcp ${c.req.method} /mcp`, handle);
    }
    return handle();
  });

  return app;
}
