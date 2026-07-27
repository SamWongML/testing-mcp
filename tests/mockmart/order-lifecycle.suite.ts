import { defineSuite } from "@atp/engine";

import { mockmart_admin_tokenAuth } from "../_shared/auth/mockmart-admin-token";
import { mockmart } from "../_shared/env/mockmart";

/**
 * Migrated from the Insomnia `Order Lifecycle` folder. Every child request referenced the
 * created order through a `{% response %}` tag, which `atp import` left as `__TODO_CHAIN__`;
 * the wiring is `extract` on `create-order` plus `{{nodes.create-order.orderId}}` downstream,
 * with `needs` making the edge explicit.
 *
 * The three reads/writes on the order are *siblings*, not a chain — they only need the id,
 * so they run concurrently and address it as `{{nodes.X.var}}` rather than `{{vars.*}}`
 * (last-writer-wins across parallel branches). `cancel-order` waits for all three.
 *
 * `preflight` is an addition, not parity: the collection had no OPTIONS request.
 */
export default defineSuite({
  id: "mockmart.order-lifecycle",
  version: 1,
  title: "Create → read → confirm → address → cancel an order",
  tags: ["mockmart", "orders", "e2e"],
  owner: "team-mockmart",
  timeoutMs: 25_000,
  env: mockmart,
  auth: [mockmart_admin_tokenAuth],
  nodes: {
    preflight: {
      request: { method: "OPTIONS", url: "{{env.baseUrl}}/orders" },
      assert: [
        { path: "status", op: "eq", value: 204 },
        { path: "headers.allow", op: "contains", value: "DELETE" },
      ],
    },
    "create-order": {
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/orders",
        headers: { "content-type": "application/json" },
        authRef: "mockmart-admin-token",
        body: { sku: "{{env.productId}}", quantity: 2 },
      },
      assert: [
        { path: "status", op: "eq", value: 201 },
        { path: "body.orderId", op: "matches", value: "^ord-" },
        { path: "body.paymentId", op: "isString" },
        { path: "body.status", op: "eq", value: "pending" },
        { path: "body.totalCents", op: "eq", value: 8400 },
        { path: "body.currency", op: "eq", value: "usd" },
      ],
      extract: [
        { as: "orderId", from: "body.orderId" },
        { as: "paymentId", from: "body.paymentId" },
      ],
    },
    "get-order": {
      needs: ["create-order"],
      request: {
        method: "GET",
        url: "{{env.baseUrl}}/orders/{{nodes.create-order.orderId}}",
        authRef: "mockmart-admin-token",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "pending" },
        { path: "body.totalCents", op: "isNumber" },
        { path: "$.body.items[0].sku", op: "jsonpath", value: "sku-1001" },
      ],
    },
    "confirm-order": {
      needs: ["create-order"],
      request: {
        method: "PATCH",
        url: "{{env.baseUrl}}/orders/{{nodes.create-order.orderId}}",
        headers: { "content-type": "application/json" },
        authRef: "mockmart-admin-token",
        body: { status: "confirmed" },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "confirmed" },
        { path: "body.updated", op: "eq", value: true },
      ],
    },
    "set-shipping-address": {
      needs: ["create-order"],
      request: {
        method: "PUT",
        url: "{{env.baseUrl}}/orders/{{nodes.create-order.orderId}}/address",
        headers: { "content-type": "application/json" },
        authRef: "mockmart-admin-token",
        body: { line1: "12 Fixture Way", city: "Testville", postcode: "TE5 7ER" },
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.updated", op: "eq", value: true },
        { path: "$.body.address.city", op: "jsonpath", value: "Testville" },
      ],
    },
    "cancel-order": {
      needs: ["get-order", "confirm-order", "set-shipping-address"],
      request: {
        method: "DELETE",
        url: "{{env.baseUrl}}/orders/{{nodes.create-order.orderId}}",
        authRef: "mockmart-admin-token",
      },
      // A 204 carries no body, so an exact status is the whole assertion — legal under
      // the strictness rules precisely because it pins one status and nothing else passes.
      assert: [{ path: "status", op: "eq", value: 204 }],
    },
  },
});
