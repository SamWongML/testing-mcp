import { defineEnv } from "@atp/engine";

/** The fixture corpus env. A plain literal, so the compiled `manifestHash` is deterministic;
 * runs override `baseUrl` with the mock SUT's ephemeral port. */
export const fixture = defineEnv({
  baseUrl: "http://127.0.0.1:8787",
});
