import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The dev server is exposed through a reverse proxy in the development
    // container. Accept the proxy's forwarded Host header instead of allowing
    // only the local Docker hostname.
    allowedHosts: true,
    proxy: {
      "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:4000", changeOrigin: true },
      "/ws": { target: process.env.VITE_API_PROXY ?? "http://localhost:4000", ws: true, changeOrigin: true },
    },
  },
});
