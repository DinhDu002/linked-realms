import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5181,
    strictPort: true,
    proxy: { "/play": { target: "ws://127.0.0.1:2567", ws: true } },
  },
});
