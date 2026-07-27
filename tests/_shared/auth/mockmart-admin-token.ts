import type { AuthProviderSpec } from "@atp/schema";

export const mockmart_admin_tokenAuth: AuthProviderSpec = {
  id: "mockmart-admin-token",
  type: "bearer",
  token: "{{secrets.ADMIN_TOKEN}}",
};
