import { defineSuite, useStep } from "@atp/engine";

import { mockmart_admin_tokenAuth } from "../_shared/auth/mockmart-admin-token";
import { mockmart_api_tokenAuth } from "../_shared/auth/mockmart-api-token";
import { mockmart } from "../_shared/env/mockmart";
import { capturePayment } from "../_shared/steps/capture-payment";

/**
 * Migrated from the Insomnia `Checkout` folder (its nested `Fulfilment` folder flattened
 * into the same suite). A strict chain: each node needs the id the previous one published,
 * so the four `__TODO_CHAIN__` placeholders became `extract` + `{{nodes.X.var}}` + `needs`.
 *
 * `capture-payment` is composed by reference from `_shared/steps` rather than re-authored,
 * and `track-shipment` polls: the shipment reports `in_transit` for its first two reads, so
 * the assertion axis (`poll`) is what settles it — not a transport retry.
 *
 * `timeoutMs` over 30s marks the entry long-running, so MCP runs it as an async task
 * (`run_suite`) rather than inline.
 */
export default defineSuite({
  id: "mockmart.checkout",
  version: 1,
  title: "Cart → checkout → capture → delivered",
  tags: ["mockmart", "checkout", "e2e"],
  owner: "team-mockmart",
  timeoutMs: 120_000,
  env: mockmart,
  auth: [mockmart_admin_tokenAuth, mockmart_api_tokenAuth],
  nodes: {
    "create-cart": {
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/carts",
        authRef: "mockmart-api-token",
      },
      assert: [
        { path: "status", op: "eq", value: 201 },
        { path: "body.cartId", op: "matches", value: "^cart-" },
        { path: "body.itemCount", op: "eq", value: 0 },
      ],
      extract: [{ as: "cartId", from: "body.cartId" }],
    },
    "add-item": {
      needs: ["create-cart"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/carts/{{nodes.create-cart.cartId}}/items",
        headers: { "content-type": "application/json" },
        authRef: "mockmart-api-token",
        body: { sku: "{{env.productId}}", quantity: 2 },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.itemCount", op: "eq", value: 2 },
        { path: "body.subtotalCents", op: "eq", value: 8400 },
      ],
      extract: [{ as: "subtotalCents", from: "body.subtotalCents" }],
    },
    "checkout-cart": {
      needs: ["add-item"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/carts/{{nodes.create-cart.cartId}}/checkout",
        authRef: "mockmart-api-token",
      },
      assert: [
        { path: "status", op: "eq", value: 201 },
        { path: "body.status", op: "eq", value: "authorized" },
        { path: "body.amountCents", op: "eq", value: 8400 },
        { path: "body.orderId", op: "matches", value: "^ord-" },
        { path: "body.paymentId", op: "matches", value: "^pay-" },
      ],
      extract: [
        { as: "orderId", from: "body.orderId" },
        { as: "paymentId", from: "body.paymentId" },
      ],
    },
    "capture-payment": useStep(capturePayment, {
      needs: ["checkout-cart"],
      with: { paymentId: "{{nodes.checkout-cart.paymentId}}" },
    }),
    "track-shipment": {
      needs: ["capture-payment"],
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/shipments/{{nodes.checkout-cart.orderId}}",
        authRef: "mockmart-admin-token",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "delivered" },
        { path: "body.carrier", op: "eq", value: "mockmart-express" },
      ],
      // Eventual consistency: re-send until the assertions pass or the budget runs out.
      poll: { untilAssertPasses: true, intervalMs: 300, maxMs: 8_000 },
    },
  },
});
