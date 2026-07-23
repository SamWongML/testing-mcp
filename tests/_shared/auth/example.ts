import { bearerAuth } from "@atp/engine";

/**
 * An example reusable auth provider (research §7 `_shared/auth`). A step selects it with
 * `request.authRef: "example"`; the CLI/server registers providers by that id. The token
 * is a `{{secrets.*}}` template — the engine resolves it at run time, so no credential is
 * ever baked into the manifest.
 */
export const exampleBearer = bearerAuth({
  id: "example",
  token: "{{secrets.API_TOKEN}}",
});
