import type { AuthProviderSpec } from "@atp/schema";

/** The `basic` auth block on the Insomnia `Legacy Ping` request (a TODO from `atp import`). */
export const mockmartLegacyAuth: AuthProviderSpec = {
  id: "mockmart-legacy",
  type: "basic",
  username: "qa-bot",
  password: "{{secrets.LEGACY_PASSWORD}}",
};
