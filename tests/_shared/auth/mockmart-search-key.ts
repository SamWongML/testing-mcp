import type { AuthProviderSpec } from "@atp/schema";

/**
 * The `apikey` auth block on the Insomnia `Search Catalog` request, which `atp import`
 * leaves as a TODO (only `bearer` is auto-mapped). Declarative like every provider: the
 * key travels as a `{{secrets.*}}` template and resolves per run from `ATP_SECRET_SEARCH_KEY`.
 */
export const mockmartSearchKeyAuth: AuthProviderSpec = {
  id: "mockmart-search-key",
  type: "apiKey",
  name: "x-api-key",
  value: "{{secrets.SEARCH_KEY}}",
  in: "header",
};
