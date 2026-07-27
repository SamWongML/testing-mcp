import type { AuthProviderSpec } from "@atp/schema";

export const mockmart_api_tokenAuth: AuthProviderSpec = {
  id: "mockmart-api-token",
  type: "bearer",
  token: "{{secrets.API_TOKEN}}",
};
