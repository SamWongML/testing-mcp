import { defineSuite, useTest } from "@atp/engine";

import { fixture } from "../_shared/env/fixture";
import createWidget from "./create-widget.test";

export default defineSuite({
  id: "alpha.widget-lifecycle",
  version: 1,
  title: "Create a widget then capture its payment",
  tags: ["alpha", "e2e"],
  owner: "team-alpha",
  env: fixture,
  nodes: {
    create: useTest(createWidget),
    capture: {
      needs: ["create"],
      request: {
        method: "POST",
        url: "{{env.baseUrl}}/payments/{{nodes.create.paymentId}}/capture",
      },
      assert: [
        { path: "status", op: "eq", value: 200 },
        { path: "body.status", op: "eq", value: "captured" },
      ],
    },
  },
});
