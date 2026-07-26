import { defineTest } from "@atp/engine";

import { mockmart_api_tokenAuth } from "../_shared/auth/mockmart-api-token";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_get_product`. The env's `productId` became a param so the
 * catalog id is a run-time input (its JSON Schema is the `run_test` tool input schema).
 */
export default defineTest({
  id: "mockmart.get-product",
  version: 1,
  title: "Fetch a catalog product by sku",
  tags: ["mockmart", "catalog", "smoke"],
  owner: "team-mockmart",
  timeoutMs: 10_000,
  env: mockmart,
  auth: [mockmart_api_tokenAuth],
  params: (z) => z.object({ productId: z.string().default("sku-1001") }),
  steps: [
    {
      id: "get-product",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/catalog/products/{{params.productId}}",
        authRef: "mockmart-api-token",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.sku", op: "isString" },
        { path: "body.priceCents", op: "gt", value: 0 },
        { path: "body.priceCents", op: "lt", value: 1_000_000 },
        { path: "body.inStock", op: "eq", value: true },
        { path: "body.tags", op: "contains", value: "widget" },
        // jsonpath addresses the whole response, so it reaches into nested arrays.
        { path: "$.body.warehouse.code", op: "jsonpath", value: "eu-west-1" },
        {
          path: "body",
          op: "jsonSchema",
          value: {
            type: "object",
            required: ["id", "sku", "name", "priceCents", "currency", "inStock"],
            properties: {
              id: { type: "string" },
              priceCents: { type: "integer" },
              currency: { type: "string", enum: ["usd", "eur"] },
              inStock: { type: "boolean" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      ],
      extract: [
        { as: "sku", from: "body.sku" },
        { as: "priceCents", from: "body.priceCents" },
      ],
    },
  ],
});
