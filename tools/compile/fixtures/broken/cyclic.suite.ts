import { defineSuite } from "@atp/engine";

// A dependency cycle: normalize() must reject this at compile time (research §12).
export default defineSuite({
  id: "fix.cyclic",
  version: 1,
  nodes: {
    a: { needs: ["b"], request: { method: "GET", url: "{{env.baseUrl}}/a" } },
    b: { needs: ["a"], request: { method: "GET", url: "{{env.baseUrl}}/b" } },
  },
});
