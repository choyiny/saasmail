import { defineConfig } from "vitest/config";

// Plain Node tests for the installer CLI (not the Workers pool).
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/saasmail/__tests__/**/*.test.ts"],
  },
});
