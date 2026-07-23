import { defineTest } from "@atp/engine";

export default defineTest({
  id: "fix.alpha",
  version: 1,
  title: "Fixture alpha",
  tags: ["fixture"],
  owner: "team-fixtures",
  timeoutMs: 5_000,
  env: { baseUrl: "https://alpha.example.com" },
  steps: [
    {
      id: "get",
      request: { method: "GET", url: "{{env.baseUrl}}/alpha" },
      assert: [{ path: "status", op: "eq", value: 200 }],
    },
  ],
});
