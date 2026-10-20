import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json";

// The workbench version has one source of truth: VERSION at the repo root, which
// the backend reads at startup. scripts/bump_version.py mirrors it into this
// package.json, so the injected build constant can never disagree with the API.
const appVersion = pkg.version;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8010",
      "/files": "http://127.0.0.1:8010",
    },
  },
  preview: { host: "0.0.0.0" },
});
