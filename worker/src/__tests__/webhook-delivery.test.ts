import { describe, expect, it, vi } from "vitest";
import { buildWebhookPayload, sendWebhook } from "../lib/webhook-delivery";
import { signWebhookBody } from "../lib/webhook-signature";

describe("buildWebhookPayload", () => {
  it("builds the documented shape, slices preview, defaults subject", () => {
    const p = buildWebhookPayload({
      emailId: "abc123",
      receivedAt: 1717459200,
      inbox: "support@d.com",
      fromAddress: "jane@example.com",
      fromName: "Jane",
      subject: null,
      bodyText: "x".repeat(500),
      conversationId: "conv1",
      attachments: [{ filename: "a.png", contentType: "image/png", size: 10 }],
      auth: { spf: "pass", dkim: "pass", dmarc: "pass" },
      baseUrl: "https://mail.d.com/",
    });
    expect(p.event).toBe("message.received");
    expect(p.id).toBe("abc123");
    expect(p.subject).toBe("");
    expect(p.from).toEqual({ address: "jane@example.com", name: "Jane" });
    expect(p.textPreview.length).toBe(280);
    expect(p.url).toBe("https://mail.d.com/m/abc123");
    expect(p.attachments).toEqual([
      { filename: "a.png", contentType: "image/png", size: 10 },
    ]);
  });
});

describe("sendWebhook", () => {
  const payload = buildWebhookPayload({
    emailId: "abc123",
    receivedAt: 1717459200,
    inbox: "support@d.com",
    fromAddress: "jane@example.com",
    fromName: null,
    subject: "Hi",
    bodyText: "hello",
    conversationId: "conv1",
    attachments: [],
    auth: { spf: null, dkim: null, dmarc: null },
    baseUrl: "https://mail.d.com",
  });

  it("POSTs JSON and signs the body when a secret is set", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 200 }));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: "shh" },
      payload,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://hook.d.com");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-SaaSMail-Event")).toBe("message.received");
    const expectedSig = await signWebhookBody(init?.body as string, "shh");
    expect(headers.get("X-SaaSMail-Signature")).toBe(expectedSig);
  });

  it("omits the signature header when no secret", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: null },
      payload,
      fetchImpl,
    );
    expect(result).toEqual({ ok: true, status: 204 });
    const headers = new Headers(fetchImpl.mock.calls[0][1]?.headers);
    expect(headers.has("X-SaaSMail-Signature")).toBe(false);
  });

  it("returns ok:false with the error message when fetch throws", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("boom"));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: null },
      payload,
      fetchImpl,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("boom");
  });

  it("reports ok:false for non-2xx without throwing", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await sendWebhook(
      { url: "https://hook.d.com", secret: null },
      payload,
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, status: 500 });
  });
});
