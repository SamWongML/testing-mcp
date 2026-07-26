import { defineTest } from "@atp/engine";

import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_login`. The collection carried a plaintext `password` in its
 * environment; the migrated form takes it as a param whose default is a `{{secrets.*}}`
 * template (resolved recursively at run time from `ATP_SECRET_QA_PASSWORD`), so nothing
 * sensitive reaches the manifest and the value is masked in the persisted trace.
 */
export default defineTest({
  id: "mockmart.login",
  version: 1,
  title: "User can log in and receive a session token",
  tags: ["mockmart", "auth", "smoke"],
  owner: "team-mockmart",
  timeoutMs: 15_000,
  env: mockmart,
  params: (z) =>
    z.object({
      email: z.string().email().default("qa@example.com"),
      password: z.string().default("{{secrets.QA_PASSWORD}}"),
    }),
  steps: [
    {
      id: "login",
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/auth/login",
        headers: { "content-type": "application/json" },
        body: { email: "{{params.email}}", password: "{{params.password}}" },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.token", op: "isString" },
        { path: "body.token", op: "matches", value: "^session-" },
        { path: "body.expiresIn", op: "gt", value: 0 },
        { path: "body.user.role", op: "eq", value: "qa" },
        { path: "body.user.id", op: "neq", value: null },
        // The escape hatch: a predicate the declarative operators can't express.
        {
          fn: (res) => {
            const body = (res as { body: { expiresIn: number; refreshToken: string } }).body;
            return body.expiresIn >= 900 && body.refreshToken.length > 0;
          },
          message: "session must last at least 15 minutes and carry a refresh token",
        },
      ],
      extract: [
        { as: "sessionToken", from: "body.token" },
        { as: "userId", from: "body.user.id" },
      ],
      retry: { max: 2, backoffMs: 250, on: ["network", "5xx"] },
    },
  ],
});
