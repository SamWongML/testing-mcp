import type { AuthoredStep } from "@atp/schema";

/**
 * A reusable step (`_shared/steps`). Suites embed it with
 * `useStep(capturePayment, { with: { paymentId } })`; the `with` bag populates this step's
 * `{{params.*}}` scope, so a caller binds the payment without duplicating the request.
 *
 * `authRef` names a provider the *consuming* entry must declare — the step is a fragment,
 * not an entry, so it carries no `auth` array of its own.
 */
export const capturePayment: AuthoredStep = {
  id: "capture-payment",
  request: {
    method: "POST",
    url: "{{env.baseUrl}}/payments/{{params.paymentId}}/capture",
    authRef: "mockmart-admin-token",
  },
  assert: [
    { path: "status", op: "eq", value: 200 },
    { path: "body.status", op: "eq", value: "captured" },
    { path: "body.capturedCents", op: "isNumber" },
  ],
  extract: [{ as: "capturedCents", from: "body.capturedCents" }],
};
