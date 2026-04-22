import { describe, it, expect, vi } from "vitest";
import { createEmailSender } from "../lib/email-sender";

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
