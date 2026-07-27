import { defineTest } from "@atp/engine";

import { mockmartSearchKeyAuth } from "../_shared/auth/mockmart-search-key";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from Insomnia `req_search`, and the corpus's matrix case: the single authored
 * definition expands into one executable entry per region × tier cell
 * (`mockmart.search-catalog#region=us,tier=free`, …). `env` is a builder rather than a
 * static object, so each cell resolves the currency/discount the SUT should answer with —
 * assertion values are literals, never templates, so the per-cell expectation has to live
 * in env and be checked by the predicate below.
 */
export default defineTest({
  id: "mockmart.search-catalog",
  version: 1,
  title: "Catalog search is priced per region and tier",
  tags: ["mockmart", "catalog"],
  owner: "team-mockmart",
  timeoutMs: 10_000,
  matrix: { region: ["us", "eu"], tier: ["free", "pro"] },
  env: (cell) => ({
    ...mockmart,
    region: String(cell.region),
    tier: String(cell.tier),
    expectedCurrency: cell.region === "eu" ? "eur" : "usd",
    expectedDiscountPct: cell.tier === "pro" ? 10 : 0,
  }),
  auth: [mockmartSearchKeyAuth],
  params: (z) => z.object({ q: z.string().default("widget") }),
  steps: [
    {
      id: "search-catalog",
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/catalog/search",
        query: {
          q: "{{params.q}}",
          // `{{matrix.*}}` carries this cell's coordinates.
          region: "{{matrix.region}}",
          tier: "{{matrix.tier}}",
        },
        authRef: "mockmart-search-key",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.query", op: "eq", value: "widget" },
        { path: "body.total", op: "eq", value: 3 },
        { path: "body.currency", op: "isString" },
        { path: "$.body.results[0].id", op: "jsonpath", value: "sku-1001" },
        {
          path: "body",
          op: "jsonSchema",
          value: {
            type: "object",
            required: ["query", "region", "tier", "currency", "total", "results"],
            properties: {
              region: { type: "string", enum: ["us", "eu"] },
              tier: { type: "string", enum: ["free", "pro"] },
              currency: { type: "string", enum: ["usd", "eur"] },
              discountPct: { type: "integer" },
              results: { type: "array", items: { type: "object", required: ["id", "priceCents"] } },
            },
          },
        },
        {
          // The cell-specific check: pricing must agree with the region/tier the SUT echoes.
          fn: (res) => {
            const body = (
              res as {
                body: { region: string; tier: string; currency: string; discountPct: number };
              }
            ).body;
            return (
              body.currency === (body.region === "eu" ? "eur" : "usd") &&
              body.discountPct === (body.tier === "pro" ? 10 : 0)
            );
          },
          message: "currency follows region and discount follows tier",
        },
      ],
      extract: [{ as: "currency", from: "body.currency" }],
    },
  ],
});
