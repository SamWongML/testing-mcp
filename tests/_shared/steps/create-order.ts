import type { AuthoredStep } from "@atp/schema";

/**
 * A reusable step (research §7 `_shared/steps`). Suites embed it by reference with
 * `useStep(createOrder, { with: { token } })`; the `with` bag populates this step's
 * `{{params.*}}` scope, so the caller binds the bearer token without duplicating the step.
 */
export const createOrder: AuthoredStep = {
  id: "create-order",
  request: {
    method: "POST",
    url: "{{env.baseUrl}}/orders",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer {{params.token}}",
    },
    body: { sku: "widget-1", quantity: 1 },
  },
  assert: [
    { path: "status", op: "eq", value: 201 },
    { path: "body.paymentId", op: "isString" },
  ],
  extract: [{ as: "paymentId", from: "body.paymentId" }],
};
