import { describe, it, expect } from "vitest";
import { signToken as signV1 } from "../lib/unsubscribe-token";
import { signPayload, verifyPayload } from "../lib/signed-token";

const SECRET = "test-secret-do-not-use-in-prod";

describe("signPayload / verifyPayload", () => {
  it("round-trips a payload within its domain", async () => {
    const token = await signPayload({ a: 1 }, SECRET, "subscribe-confirm");
    expect(await verifyPayload(token, SECRET, "subscribe-confirm")).toEqual({
      a: 1,
    });
  });

  it("rejects a tampered signature", async () => {
    const token = await signPayload({ a: 1 }, SECRET, "subscribe-confirm");
    const [payload, sig] = token.split(".");
    const flipped = sig[0] === "A" ? "B" : "A";
    const tampered = `${payload}.${flipped}${sig.slice(1)}`;
    expect(
      await verifyPayload(tampered, SECRET, "subscribe-confirm"),
    ).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const token = await signPayload({ a: 1 }, SECRET, "subscribe-confirm");
    const sig = token.split(".")[1];
    const forged = `${btoa('{"a":2}').replace(/=/g, "")}.${sig}`;
    expect(await verifyPayload(forged, SECRET, "subscribe-confirm")).toBeNull();
  });

  it("rejects the wrong secret", async () => {
    const token = await signPayload({ a: 1 }, SECRET, "subscribe-confirm");
    expect(
      await verifyPayload(token, "other-secret", "subscribe-confirm"),
    ).toBeNull();
  });

  it.each(["", "nodot", "a.b.c", "!!.??"])(
    "rejects the malformed token %j",
    async (bad) => {
      expect(await verifyPayload(bad, SECRET, "subscribe-confirm")).toBeNull();
    },
  );

  /**
   * The point of domain separation: an open-tracking pixel URL leaks through
   * image caches, proxies and browser history far more readily than an
   * unsubscribe link, so a token lifted from one context must be inert in
   * another even though both are signed with the same root secret.
   */
  it("rejects a token replayed against a different domain", async () => {
    const token = await signPayload({ a: 1 }, SECRET, "track-open");
    expect(await verifyPayload(token, SECRET, "subscribe-confirm")).toBeNull();
    expect(await verifyPayload(token, SECRET, "track-click")).toBeNull();
    expect(await verifyPayload(token, SECRET, "track-open")).toEqual({ a: 1 });
  });

  /**
   * v1 unsubscribe tokens are signed with the raw secret and are already in the
   * wild inside delivered email. Deriving a key for the new domains must not
   * change how those verify, so the two schemes must produce different
   * signatures for the same input and never validate each other's tokens.
   */
  it("does not collide with the existing v1 unsubscribe token scheme", async () => {
    const v1 = await signV1("alice@example.com", SECRET);
    expect(await verifyPayload(v1, SECRET, "unsubscribe")).toBeNull();
  });

  describe("expiry", () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const future = Math.floor(Date.now() / 1000) + 3600;

    it("accepts a token whose exp is in the future", async () => {
      const token = await signPayload(
        { a: 1, exp: future },
        SECRET,
        "subscribe-confirm",
      );
      expect(
        await verifyPayload(token, SECRET, "subscribe-confirm"),
      ).toMatchObject({ a: 1 });
    });

    it("rejects an expired token", async () => {
      const token = await signPayload(
        { a: 1, exp: past },
        SECRET,
        "subscribe-confirm",
      );
      expect(
        await verifyPayload(token, SECRET, "subscribe-confirm"),
      ).toBeNull();
    });

    it("reports expiry distinctly so the caller can return 410 rather than 400", async () => {
      const token = await signPayload(
        { a: 1, exp: past },
        SECRET,
        "subscribe-confirm",
      );
      expect(
        await verifyPayload(token, SECRET, "subscribe-confirm", {
          detailed: true,
        }),
      ).toEqual({ status: "expired" });
      expect(
        await verifyPayload("garbage", SECRET, "subscribe-confirm", {
          detailed: true,
        }),
      ).toEqual({ status: "invalid" });
    });

    it("treats a token with no exp as non-expiring", async () => {
      const token = await signPayload({ a: 1 }, SECRET, "track-open");
      expect(await verifyPayload(token, SECRET, "track-open")).toEqual({
        a: 1,
      });
    });
  });
});
