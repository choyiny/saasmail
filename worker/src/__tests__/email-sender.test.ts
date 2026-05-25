import { describe, it, expect, vi } from "vitest";
import { createEmailSender, BavimailSender } from "../lib/email-sender";

describe("createEmailSender", () => {
  it("picks Resend when RESEND_API_KEY is set", () => {
    const sender = createEmailSender({
      RESEND_API_KEY: "re_test",
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("resend");
  });

  it("picks Cloudflare when only EMAIL binding is present", () => {
    const sender = createEmailSender({
      EMAIL: { send: vi.fn() },
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("cloudflare");
  });

  it("picks Resend when both are set (Resend takes precedence)", () => {
    const sender = createEmailSender({
      RESEND_API_KEY: "re_test",
      EMAIL: { send: vi.fn() },
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("resend");
  });

  it("returns a stub when neither is configured", async () => {
    const sender = createEmailSender({} as unknown as CloudflareBindings);
    expect(sender.provider).toBe("none");
    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      html: "<p>x</p>",
    });
    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("No email provider configured");
  });

  it("picks Bavimail when BAVIMAIL_API_KEY and BAVIMAIL_ALIAS_ID are set, even over Resend and Cloudflare", () => {
    const sender = createEmailSender({
      BAVIMAIL_API_KEY: "bm_test",
      BAVIMAIL_ALIAS_ID: "alias-uuid",
      RESEND_API_KEY: "re_test",
      EMAIL: { send: vi.fn() },
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("bavimail");
  });

  it("falls through to Resend if BAVIMAIL_ALIAS_ID is missing", () => {
    const sender = createEmailSender({
      BAVIMAIL_API_KEY: "bm_test",
      RESEND_API_KEY: "re_test",
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("resend");
  });

  it("falls through to Resend if BAVIMAIL_API_KEY is missing", () => {
    const sender = createEmailSender({
      BAVIMAIL_ALIAS_ID: "alias-uuid",
      RESEND_API_KEY: "re_test",
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("resend");
  });
});

describe("CloudflareSender", () => {
  it("sends a raw MIME message with custom headers embedded", async () => {
    const fakeBinding = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-123" }),
    };
    const sender = createEmailSender({
      EMAIL: fakeBinding,
    } as unknown as CloudflareBindings);

    const result = await sender.send({
      from: '"Alice" <a@b.com>',
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
      headers: {
        "Message-ID": "<new@msg>",
        "In-Reply-To": "<orig@msg>",
      },
    });

    expect(result.id).toBe("msg-123");
    expect(result.error).toBeNull();
    expect(fakeBinding.send).toHaveBeenCalledTimes(1);
    const sent = fakeBinding.send.mock.calls[0][0] as {
      from: string;
      to: string;
    };
    // EmailMessage uses the bare address as the envelope sender.
    expect(sent.from).toBe("a@b.com");
    expect(sent.to).toBe("c@d.com");
    const serialized = JSON.stringify(sent);
    expect(serialized).toContain("Message-ID: <new@msg>");
    expect(serialized).toContain("In-Reply-To: <orig@msg>");
    expect(serialized).toContain("text/plain");
    expect(serialized).toContain("text/html");
  });

  it("catches thrown errors and returns normalized result", async () => {
    const fakeBinding = {
      send: vi.fn().mockRejectedValue(new Error("sender not allowed")),
    };
    const sender = createEmailSender({
      EMAIL: fakeBinding,
    } as unknown as CloudflareBindings);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "x",
      html: "<p>x</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("sender not allowed");
  });
});

describe("maxAttachmentBytes", () => {
  it("returns 25MB for Resend", () => {
    const sender = createEmailSender({
      RESEND_API_KEY: "re_test",
    } as any);
    expect(sender.maxAttachmentBytes()).toBe(25 * 1024 * 1024);
  });

  it("returns ~18MB for Cloudflare", () => {
    const sender = createEmailSender({
      EMAIL: { send: async () => ({ messageId: "x" }) },
    } as any);
    // 25MB / 1.4 = ~18.7MB raw budget so post-base64 fits 25MB.
    expect(sender.maxAttachmentBytes()).toBe(
      Math.floor((25 * 1024 * 1024) / 1.4),
    );
  });

  it("returns 0 for NoopSender", () => {
    const sender = createEmailSender({} as any);
    expect(sender.maxAttachmentBytes()).toBe(0);
  });

  it("returns 25MB for Bavimail", () => {
    const sender = createEmailSender({
      BAVIMAIL_API_KEY: "bm_test",
      BAVIMAIL_ALIAS_ID: "alias-uuid",
    } as any);
    expect(sender.maxAttachmentBytes()).toBe(25 * 1024 * 1024);
  });
});

describe("BavimailSender", () => {
  function makeBavimailSender(fetchFn: typeof fetch) {
    return new BavimailSender("bm_test", "alias-uuid", fetchFn);
  }

  it("sends a basic email with bearer token and correct body", async () => {
    const sendResponse = new Response(JSON.stringify({ id: "bm-msg-123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
    const fetchMock = vi.fn().mockResolvedValue(sendResponse);
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: '"Alice" <a@b.com>',
      to: '"Bob" <c@d.com>',
      subject: "hello",
      html: "<p>hi</p>",
    });

    expect(result.error).toBeNull();
    expect(result.id).toBe("bm-msg-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.bavimail.com/emails");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer bm_test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      alias_id: "alias-uuid",
      to_email: "c@d.com",
      subject: "hello",
      body: "<p>hi</p>",
    });
  });

  it("includes cc_emails when cc is present, omits when empty", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "x" }), { status: 201 }),
      );
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      cc: ['"Eve" <e@f.com>', "g@h.com"],
      subject: "s",
      html: "<p>h</p>",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.cc_emails).toEqual(["e@f.com", "g@h.com"]);
  });

  it("includes in_reply_to when headers contain In-Reply-To", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: "x" }), { status: 201 }),
      );
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
      headers: { "In-Reply-To": "<orig@msg>" },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.in_reply_to).toBe("<orig@msg>");
  });
});
