import { defineConfig } from "vitest/config";
import { cloudflarePool } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  test: {
    globals: true,
    include: ["worker/src/__tests__/**/*.test.ts"],
    pool: cloudflarePool({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          // `wrangler.jsonc` ships a `<your-deployed-url>` placeholder so new
          // clones don't accidentally send tests to a real deployment. Override
          // with a valid URL so BetterAuth initializes during tests.
          BASE_URL: "http://localhost:8080",
          TRUSTED_ORIGINS: "http://localhost:8080,http://localhost:8788",
          RESEND_API_KEY: "re_test_fake_key",
          // Tests authenticate via API keys (no WebAuthn ceremony available).
          // Disable the passkey gate so the existing fixtures keep working;
          // the enforcement itself is covered by targeted tests in
          // `__tests__/passkey-enforcement.test.ts`.
          DISABLE_PASSKEY_GATE: "true",
          // `.dev.vars` sets DEMO_MODE=1 for `yarn dev`, and miniflare
          // auto-loads those secrets. Force it off for tests so sequence
          // processor / enroll route exercise real (non-demo) behavior.
          DEMO_MODE: "0",
          VAPID_PRIVATE_KEY: "test-vapid-private",
          VAPID_PUBLIC_KEY: "test-vapid-public",
        },
      },
    }),
  },
});
