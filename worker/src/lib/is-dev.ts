/**
 * Returns true when the worker is running in a local/test environment where
 * passkey enforcement should be relaxed so maintainers can exercise the UI
 * without a real WebAuthn ceremony.
 *
 * Gated by an explicit `DISABLE_PASSKEY_GATE="true"` var rather than a URL
 * heuristic — deployers sometimes point their local `wrangler.jsonc` at a
 * real staging host, so BASE_URL isn't a reliable signal. Must be opt-in.
 *
 * Demo deploys (see `isDemoMode`) also bypass the passkey gate so preview
 * instances can be explored without registering a WebAuthn credential.
 */
export function isDevEnvironment(env: CloudflareBindings | undefined): boolean {
  return (env as any)?.DISABLE_PASSKEY_GATE === "true" || isDemoMode(env);
}

/**
 * Returns true when the worker is running in "demo" mode — a stripped-down
 * deploy that only talks to D1 (and R2 if present), skipping queue
 * enqueues and outbound email sends. Intended for sample/preview deployments
 * where you want to exercise the UI/DB without provisioning queues or an
 * email provider.
 *
 * Toggled by `DEMO_MODE="1"` in the worker's vars (see `wrangler.demo.jsonc`).
 */
export function isDemoMode(env: CloudflareBindings | undefined): boolean {
  return (env as any)?.DEMO_MODE === "1";
}
