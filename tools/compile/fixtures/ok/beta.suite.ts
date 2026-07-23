import { defineSuite } from "@atp/engine";

export default defineSuite({
  id: "fix.beta",
  version: 1,
  title: "Fixture beta suite",
  tags: ["fixture"],
  nodes: {
    first: {
      request: { method: "GET", url: "{{env.baseUrl}}/first" },
      assert: [{ path: "status", op: "eq", value: 200 }],
    },
    second: {
      needs: ["first"],
      request: { method: "GET", url: "{{env.baseUrl}}/second" },
      assert: [{ path: "status", op: "eq", value: 200 }],
    },
  },
});
