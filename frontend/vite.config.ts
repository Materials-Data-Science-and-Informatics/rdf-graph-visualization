import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vitejs.dev/config/
export default defineConfig({
  assetsInclude: ["./config.yml"],
  plugins: [react()],
  server: {
    // Dev only: proxy API calls to the backend (uvicorn on :8000, see
    // docker/supervisord.conf). In production nginx does the same (docker/nginx.conf).
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
});
