import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from "node:child_process";

// Starts the Python backend (port 8000) alongside `vite`, so `npm run dev` brings up both and
// dies with both. Dev only: `apply: "serve"` keeps it out of the build.
function backend() {
  let proc: ChildProcess | undefined;
  return {
    name: "shadow-backend",
    apply: "serve" as const,
    configureServer() {
      proc = spawn("python", ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000"], {
        cwd: "server",
        stdio: "inherit",
        shell: process.platform === "win32", // resolve `python` from PATH on Windows
      });
      const stop = () => proc?.kill();
      process.on("exit", stop);
      process.once("SIGINT", () => { stop(); process.exit(); });
    },
  };
}

// The two local services this page talks to. Both listen on 127.0.0.1 only: no photo leaves
// the machine. /galeria is https because the live phone camera needs a secure origin.
export default defineConfig({
  plugins: [react(), backend()],
  server: {
    port: 5173,
    proxy: {
      "/studio": { target: "http://127.0.0.1:8000", changeOrigin: true, rewrite: (p: string) => p.replace(/^\/studio/, "") },
      "/galeria": { target: "https://127.0.0.1:5180", changeOrigin: true, secure: false, rewrite: (p: string) => p.replace(/^\/galeria/, "") },
    },
  },
});
