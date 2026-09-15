import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    allowedHosts: ["autotrade.mrsahni.tech"],
    proxy: {
      "/api": { target: process.env.VITE_API_PROXY ?? "http://localhost:4000", changeOrigin: true },
      "/ws": { target: process.env.VITE_API_PROXY ?? "http://localhost:4000", ws: true, changeOrigin: true },
    },
  },
});
