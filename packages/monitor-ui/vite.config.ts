import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Hermes Handoff Monitor — Vite build.
//
// The SPA is bundled to `dist/` and served by `services/slack-operator`
// from the same HTTP server that serves the legacy HTML monitor (M5'+).
// `base: "./"` keeps asset URLs relative so the bundle works whether it
// is mounted at `/` or `/monitor`.
export default defineConfig({
  plugins: [react()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
  },
});
