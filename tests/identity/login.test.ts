import { defineTest } from "@atp/engine";

import { local } from "../_shared/env/local";

/**
 * A standalone test (research §7.1). Runnable on its own via `atp run identity.login` and
 * reused by `billing/end-to-end-refund.suite.ts` — one definition, two consumers. `params`
 * is a Zod schema, so the MCP tool input schema is derived from it. The `password` default
 * is a dev literal here; a real run passes it as a param or via `{{secrets.*}}`.
 */
export default defineTest({
  id: "identity.login",
  version: 1,
  title: "User can log in and receive a token",
  tags: ["identity", "auth", "smoke"],
  owner: "team-identity",
  timeoutMs: 15_000,
  env: local,
  params: (z) =>
    z.object({
      email: z.string().email().default("qa@example.com"),
      password: z.string().default("qa-password"),
    }),
  steps: [
    {
      id: "post-login",
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/auth/login",
        headers: { "content-type": "application/json" },
        body: { email: "{{params.email}}", password: "{{params.password}}" },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.token", op: "isString" },
        { path: "headers.content-type", op: "contains", value: "application/json" },
        // Escape hatch: a typed predicate for logic the declarative operators can't express.
        {
          fn: (res) => (res as { body: { expiresIn: number } }).body.expiresIn > 0,
          message: "token must not be expired",
        },
      ],
      extract: [
        { as: "authToken", from: "body.token" },
        { as: "userId", from: "body.user.id" },
      ],
      retry: { max: 2, backoffMs: 500, on: ["network", "5xx"] },
    },
  ],
});
