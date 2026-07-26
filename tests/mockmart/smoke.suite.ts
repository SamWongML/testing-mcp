import { defineSuite, useTest } from "@atp/engine";

import { mockmartFeaturedKeyAuth } from "../_shared/auth/mockmart-featured-key";
import { mockmart_api_tokenAuth } from "../_shared/auth/mockmart-api-token";
import { mockmart } from "../_shared/env/mockmart";
import featuredProducts from "./featured-products.test";
import getProduct from "./get-product.test";
import login from "./login.test";

/**
 * Not migrated — composed (the `generate_suite` workflow). Three tests that already exist
 * are embedded **by reference** with `useTest`, so there is one definition of each request
 * and this suite only adds the ordering: log in, then read the catalog as that session.
 *
 * A composed node inherits the reused test's `authRef`, so the providers it selects must be
 * declared here too. `featured-products` needs nothing from `login`, so it runs in parallel.
 */
export default defineSuite({
  id: "mockmart.smoke",
  version: 1,
  title: "Smoke: log in and read the catalog",
  tags: ["mockmart", "smoke"],
  owner: "team-mockmart",
  timeoutMs: 20_000,
  env: mockmart,
  auth: [mockmart_api_tokenAuth, mockmartFeaturedKeyAuth],
  nodes: {
    session: useTest(login, { params: { email: "smoke-bot@example.com" } }),
    product: useTest(getProduct, { needs: ["session"], params: { productId: "sku-1002" } }),
    featured: useTest(featuredProducts),
  },
});
