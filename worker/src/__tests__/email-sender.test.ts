import { describe, it, expect, vi } from "vitest";
import {
  createEmailSender,
  BavimailSender,
  PostmarkSender,
} from "../lib/email-sender";

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

  it("picks Postmark when POSTMARK_API_KEY is set, even over Resend and Cloudflare", () => {
    const sender = createEmailSender({
      POSTMARK_API_KEY: "pm_test",
      RESEND_API_KEY: "re_test",
      EMAIL: { send: vi.fn() },
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("postmark");
  });

  it("prefers Bavimail over Postmark when both are configured", () => {
    const sender = createEmailSender({
      BAVIMAIL_API_KEY: "bm_test",
      BAVIMAIL_ALIAS_ID: "alias-uuid",
      POSTMARK_API_KEY: "pm_test",
    } as unknown as CloudflareBindings);
    expect(sender.provider).toBe("bavimail");
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

  it("serializes a Reply-To header without throwing", async () => {
    // Regression: Reply-To is a single-mailbox header in mimetext, so a bare
    // string threw MIMETEXT_INVALID_HEADER_VALUE and was swallowed as a failed
    // send. It must be wrapped in a Mailbox and round-trip into the raw MIME.
    const fakeBinding = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-rt" }),
    };
    const sender = createEmailSender({
      EMAIL: fakeBinding,
    } as unknown as CloudflareBindings);

    const result = await sender.send({
      from: "noreply@readerful.com",
      to: "team@readerful.com",
      subject: "contact form",
      html: "<p>hi</p>",
      headers: {
        "Message-ID": "<new@msg>",
        "Reply-To": "submitter@example.com",
      },
    });

    expect(result.error).toBeNull();
    expect(result.id).toBe("msg-rt");
    const sent = fakeBinding.send.mock.calls[0][0];
    expect(JSON.stringify(sent)).toContain("Reply-To: <submitter@example.com>");
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

  it("returns ~7MB for Postmark", () => {
    const sender = createEmailSender({
      POSTMARK_API_KEY: "pm_test",
    } as any);
    // Postmark caps total message size at 10MB; base64 inflates ~1.4x.
    expect(sender.maxAttachmentBytes()).toBe(
      Math.floor((10 * 1024 * 1024) / 1.4),
    );
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

  it("includes reply_to when headers contain Reply-To", async () => {
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
      headers: { "Reply-To": "submitter@example.com" },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_to).toBe("submitter@example.com");
  });

  it("uploads attachments first, then sends email with attachment IDs", async () => {
    const uploadResponse = new Response(
      JSON.stringify({
        attachments: [
          { id: "att-1", filename: "a.txt" },
          { id: "att-2", filename: "b.txt" },
        ],
        uploaded_at: "2026-05-25T00:00:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const sendResponse = new Response(JSON.stringify({ id: "bm-msg-xyz" }), {
      status: 201,
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(uploadResponse)
      .mockResolvedValueOnce(sendResponse);

    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "with attachments",
      html: "<p>h</p>",
      attachments: [
        {
          filename: "a.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("alpha"),
        },
        {
          filename: "b.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("bravo"),
        },
      ],
    });

    expect(result.error).toBeNull();
    expect(result.id).toBe("bm-msg-xyz");

    // First call: upload
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0];
    expect(uploadUrl).toBe("https://api.bavimail.com/attachments");
    expect((uploadInit as RequestInit).method).toBe("POST");
    // Crucial: do NOT manually set Content-Type for FormData — fetch sets the
    // boundary automatically. Manually setting it omits the boundary and
    // breaks the upload.
    const uploadHeaders = (uploadInit as RequestInit).headers as Record<
      string,
      string
    >;
    expect(uploadHeaders["Content-Type"]).toBeUndefined();
    expect(uploadHeaders["Authorization"]).toBe("Bearer bm_test");
    expect((uploadInit as RequestInit).body).toBeInstanceOf(FormData);
    const fd = (uploadInit as RequestInit).body as FormData;
    const files = fd.getAll("files");
    expect(files).toHaveLength(2);

    // Second call: send
    const [sendUrl, sendInit] = fetchMock.mock.calls[1];
    expect(sendUrl).toBe("https://api.bavimail.com/emails");
    const sendBody = JSON.parse((sendInit as RequestInit).body as string);
    expect(sendBody.attachments).toEqual([
      { attachment_id: "att-1", is_inline: false },
      { attachment_id: "att-2", is_inline: false },
    ]);
  });

  it("makes only one fetch call when there are no attachments", async () => {
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
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://api.bavimail.com/emails");
  });

  it("returns error and skips /emails when /attachments returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "file too large" }), {
        status: 413,
      }),
    );
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
      attachments: [
        {
          filename: "a.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("alpha"),
        },
      ],
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("file too large");
    // Only the upload call was made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns error when /emails returns non-2xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: "invalid alias" }), {
        status: 400,
      }),
    );
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("invalid alias");
  });

  it("falls back to status text when the error body cannot be parsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 500 }));
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toMatch(/500/);
  });

  it("normalizes thrown fetch errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const sender = makeBavimailSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("network down");
  });
});

describe("PostmarkSender", () => {
  function makePostmarkSender(fetchFn: typeof fetch) {
    return new PostmarkSender("pm_test", fetchFn);
  }

  function okResponse(body: Record<string, unknown>) {
    return new Response(JSON.stringify({ ErrorCode: 0, ...body }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  it("sends a basic email with the server token and correct body", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(okResponse({ MessageID: "pm-msg-123" }));
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: '"Alice" <a@b.com>',
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
      text: "hi",
    });

    expect(result.error).toBeNull();
    expect(result.id).toBe("pm-msg-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.postmarkapp.com/email");
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["X-Postmark-Server-Token"]).toBe("pm_test");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      From: '"Alice" <a@b.com>',
      To: "c@d.com",
      Subject: "hello",
      HtmlBody: "<p>hi</p>",
      TextBody: "hi",
    });
  });

  it("joins cc into a comma-separated Cc string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ MessageID: "x" }));
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      cc: ['"Eve" <e@f.com>', "g@h.com"],
      subject: "s",
      html: "<p>h</p>",
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Cc).toBe('"Eve" <e@f.com>,g@h.com');
  });

  it("maps Reply-To to ReplyTo and routes other headers through Headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ MessageID: "x" }));
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
      headers: {
        "Reply-To": "submitter@example.com",
        "In-Reply-To": "<orig@msg>",
        "Message-ID": "<new@msg>",
      },
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.ReplyTo).toBe("submitter@example.com");
    expect(body.Headers).toEqual([
      { Name: "In-Reply-To", Value: "<orig@msg>" },
      { Name: "Message-ID", Value: "<new@msg>" },
    ]);
  });

  it("base64-encodes attachments into the Attachments array", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ MessageID: "x" }));
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
      attachments: [
        {
          filename: "a.txt",
          contentType: "text/plain",
          content: new TextEncoder().encode("alpha"),
        },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.Attachments).toEqual([
      {
        Name: "a.txt",
        Content: btoa("alpha"),
        ContentType: "text/plain",
      },
    ]);
  });

  it("returns error from the Message field on a non-2xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ErrorCode: 300, Message: "Invalid 'From' address" }),
          { status: 422 },
        ),
      );
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("Invalid 'From' address");
  });

  it("treats a 200 with a non-zero ErrorCode as a failure", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ ErrorCode: 405, Message: "Not allowed to send" }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("Not allowed to send");
  });

  it("falls back to status text when the error body cannot be parsed", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("not json", { status: 500 }));
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toMatch(/500/);
  });

  it("normalizes thrown fetch errors", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    const sender = makePostmarkSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.message).toBe("network down");
  });
});
