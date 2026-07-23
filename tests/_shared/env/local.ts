import { defineEnv } from "@atp/engine";

/**
 * The `local` environment (`{{env.*}}` source). Points at the local mock SUT so the
 * sample corpus runs offline via `atp run`. `ATP_BASE_URL` overrides the default — the
 * CLI sets it to the mock server it boots on an ephemeral port.
 */
export const local = defineEnv({
  baseUrl: process.env.ATP_BASE_URL ?? "http://127.0.0.1:8787",
});
