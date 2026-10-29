import { resolve } from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { shellHeaders } from "./src/headers.ts";

export default defineConfig(({ mode }) => {
  const hubUrl =
    loadEnv(mode, import.meta.dirname, "VITE_").VITE_HUB_URL ||
    "http://localhost:8787";
  return {
    appType: "mpa",
    server: {
      port: 5182,
      strictPort: true,
      headers: shellHeaders(hubUrl, true),
    },
    preview: { port: 4182, strictPort: true, headers: shellHeaders(hubUrl) },
    build: {
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "index.html"),
          setup: resolve(import.meta.dirname, "setup.html"),
        },
      },
    },
    test: { include: ["src/**/*.test.ts"] },
  };
});
