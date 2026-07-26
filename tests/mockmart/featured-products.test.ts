import { defineTest } from "@atp/engine";

import { mockmartFeaturedKeyAuth } from "../_shared/auth/mockmart-featured-key";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_featured`, whose `apikey` auth went in the query string —
 * the provider carries `in: "query"`, so the key never appears in the authored url.
 */
export default defineTest({
  id: "mockmart.featured-products",
  version: 1,
  title: "Featured products are returned to an api-key caller",
  tags: ["mockmart", "catalog"],
  owner: "team-mockmart",
  timeoutMs: 10_000,
  env: mockmart,
  auth: [mockmartFeaturedKeyAuth],
  steps: [
    {
      id: "featured-products",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/catalog/featured",
        authRef: "mockmart-featured-key",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.count", op: "eq", value: 2 },
        { path: "$.body.items[0].id", op: "jsonpath", value: "sku-1001" },
        { path: "$.body.items[1].id", op: "jsonpath", value: "sku-1003" },
        {
          path: "body",
          op: "jsonSchema",
          value: {
            type: "object",
            required: ["count", "items"],
            properties: {
              count: { type: "integer" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "name", "priceCents"],
                  properties: { id: { type: "string" }, priceCents: { type: "integer" } },
                },
              },
            },
          },
        },
      ],
    },
  ],
});
