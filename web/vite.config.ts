import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the API runs separately (`npm run serve`, port 8787); proxying keeps
// the browser on one origin so no CORS is needed, exactly as in production
// where src/server.ts serves this build itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://127.0.0.1:${process.env.WEB_PORT ?? 8787}`,
        changeOrigin: false,
      },
    },
  },
});
