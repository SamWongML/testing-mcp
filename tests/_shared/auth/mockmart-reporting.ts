import type { AuthProviderSpec } from "@atp/schema";

/**
 * The `oauth2` client-credentials block on the Insomnia `Daily Report` request. The engine
 * fetches the token once per run and caches it for the run's remaining nodes.
 */
export const mockmartReportingAuth: AuthProviderSpec = {
  id: "mockmart-reporting",
  type: "oauth2ClientCredentials",
  tokenUrl: "{{env.baseUrl}}/oauth/token",
  clientId: "reporting-bot",
  clientSecret: "{{secrets.OAUTH_CLIENT_SECRET}}",
  scope: "reports:read",
};
