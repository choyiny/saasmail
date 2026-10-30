import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "jsdom",
    execArgv: ["--no-experimental-webstorage"],
    include: ["src/**/*.test.{ts,tsx}", "scripts/**/*.test.mjs"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@worker": path.resolve(__dirname, "./worker/src"),
    },
  },
});
