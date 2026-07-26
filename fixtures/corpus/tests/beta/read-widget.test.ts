import { defineTest } from "@atp/engine";

import { fixture } from "../_shared/env/fixture";

/**
 * The authenticated fixture entry. Its provider is declared data carried by the manifest, and
 * its credential is a `{{secrets.*}}` template — so a run only succeeds if the driver forwarded
 * both `entry.auth` and the secrets bag. Neither is inferable from a passing status alone,
 * which is the point: a missing provider errors with `unknown authRef`, a missing secret with
 * `unresolved template variable`.
 */
export default defineTest({
  id: "beta.read-widget",
  version: 1,
  title: "Reading a widget returns its amount",
  tags: ["beta"],
  owner: "team-beta",
  env: fixture,
  auth: [{ id: "beta-api", type: "bearer", token: "{{secrets.FIXTURE_TOKEN}}" }],
  steps: [
    {
      id: "read",
      request: { method: "GET", url: "{{env.baseUrl}}/invoices/inv-1", authRef: "beta-api" },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.id", op: "eq", value: "inv-1" },
        { path: "body.amount", op: "isNumber" },
      ],
    },
  ],
});
