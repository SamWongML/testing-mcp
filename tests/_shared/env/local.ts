import { defineEnv } from "@atp/engine";

/**
 * The `local` environment (`{{env.*}}` source), pointing at the local mock SUT. This is a
 * plain literal so the resolved `env` baked into the compiled manifest — and therefore the
 * `manifestHash` — is deterministic, never dependent on ambient process env. The run-time
 * override lives in the CLI: `atp run` honors `ATP_BASE_URL`, else boots a mock SUT and
 * injects its ephemeral URL as `baseUrl`.
 */
export const local = defineEnv({
  baseUrl: "http://127.0.0.1:8787",
});
