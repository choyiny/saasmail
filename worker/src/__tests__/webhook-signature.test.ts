import { describe, expect, it } from "vitest";
import { signWebhookBody } from "../lib/webhook-signature";

describe("signWebhookBody", () => {
  it("matches the known HMAC-SHA256 vector, sha256= hex format", async () => {
    const sig = await signWebhookBody(
      "The quick brown fox jumps over the lazy dog",
      "key",
    );
    expect(sig).toBe(
      "sha256=f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });

  it("is deterministic and secret-dependent", async () => {
    const a = await signWebhookBody("body", "s1");
    const b = await signWebhookBody("body", "s1");
    const c = await signWebhookBody("body", "s2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});
