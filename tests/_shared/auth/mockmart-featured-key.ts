import type { AuthProviderSpec } from "@atp/schema";

/**
 * The same `apikey` type as `mockmart-search-key`, but carried in the query string
 * (`addTo: queryParams` in Insomnia) — the `in: "query"` arm of the provider.
 */
export const mockmartFeaturedKeyAuth: AuthProviderSpec = {
  id: "mockmart-featured-key",
  type: "apiKey",
  name: "api_key",
  value: "{{secrets.FEATURED_KEY}}",
  in: "query",
};
