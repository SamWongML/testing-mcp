import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // `cdk.out` is CDK's synth output (templates + bundled asset JS) — generated, never authored.
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "**/cdk.out/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
