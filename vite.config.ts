import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The two local services this page talks to. Both listen on 127.0.0.1 only: no photo leaves
// the machine. /galeria is https because the live phone camera needs a secure origin.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/studio": { target: "http://127.0.0.1:8000", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/studio/, "") },
      "/galeria": { target: "https://127.0.0.1:5180", changeOrigin: true, secure: false, rewrite: (p: string) => p.replace(/^\/galeria/, "") },
    },
  },
});
