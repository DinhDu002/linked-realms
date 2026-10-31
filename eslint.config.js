import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: [
      "**/dist/",
      "target/",
      "packages/core/pkg/",
      "packages/shared/src/gen/",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
);
