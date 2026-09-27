import { defineConfig } from "vite";

// In dev, the Rust server (`strata serve --port 7420`) answers /api; Vite serves the UI.
export default defineConfig({
  server: {
    port: 5173,
    proxy: { "/api": { target: "http://127.0.0.1:7420", changeOrigin: true } },
  },
  build: { target: "es2022", sourcemap: true, chunkSizeWarningLimit: 2000 },
  worker: { format: "es" },
  test: { environment: "node" },
} as any);
