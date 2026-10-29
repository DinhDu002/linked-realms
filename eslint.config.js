import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  { ignores: ["contracts/", "**/dist/", "target/", "packages/core/pkg/"] },
  js.configs.recommended,
  tseslint.configs.recommended,
);
