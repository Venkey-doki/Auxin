/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), tailwindcss()],

  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      // Tests, the dev-only fake backend, and type-only or entry files.
      exclude: ["src/**/*.test.{ts,tsx}", "src/dev/**", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text-summary", "lcov"],
      reportsDirectory: "coverage/frontend",
      // A floor at today's level, so overall coverage can't slide back. New code is held to
      // 90% per pull request by Codecov (codecov.yml). Raise these as coverage grows.
      thresholds: { lines: 34, statements: 34, functions: 70, branches: 84 },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
