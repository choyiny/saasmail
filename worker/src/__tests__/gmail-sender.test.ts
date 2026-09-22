import { describe, it, expect, vi } from "vitest";
import { GmailSender, toBase64Url } from "../lib/email-sender/providers/gmail";

const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

function okResponse(body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function decodeBase64Url(b64url: string): string {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** mimetext RFC2047-encodes header values (Subject, display names) as
 * `=?utf-8?B?...?=`. Decode those so assertions can check plain content. */
function decodeMimeEncodedWords(text: string): string {
  return text.replace(/=\?utf-8\?B\?([A-Za-z0-9+/=]+)\?=/gi, (_, b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  });
}

function makeSender(
  fetchFn: typeof fetch,
  token: string | (() => Promise<string>) = "gm_test_token",
) {
  return new GmailSender(token, fetchFn);
}

// NOTE: the production default `fetch` must be bound to globalThis — an
// unbound global fetch invoked as a method reference (`this.fetchFn(...)`)
// throws "Illegal invocation" in the Workers runtime (see the constructor).
// We deliberately do NOT unit-test the un-injected default path here, same
// as PostmarkSender: exercising it makes a real outbound fetch, which the
// vitest-pool-workers runtime blocks in a way that leaks across isolates.

describe("toBase64Url", () => {
  it("substitutes - and _ for + and /, and strips padding", () => {
    // These specific bytes are chosen because their standard base64
    // encoding contains "+", "/", AND padding ("/1+KBw=="), so the
    // substitution is actually exercised rather than accidentally
    // vacuous on input that happens not to need it.
    const bytes = new Uint8Array([255, 95, 138, 7]);
    const std = btoa(String.fromCharCode(...bytes));
    expect(std).toBe("/1+KBw==");

    const result = toBase64Url(bytes);
    expect(result).toBe("_1-KBw");
    expect(result).not.toMatch(/[+/=]/);
  });
});

describe("GmailSender", () => {
  it("posts to the Gmail send endpoint with a bearer token and returns the message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "18abc" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
    });

    expect(result.error).toBeNull();
    expect(result.id).toBe("18abc");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(SEND_URL);
    expect((init as RequestInit).method).toBe("POST");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer gm_test_token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("resolves an access token from a function when given one instead of a string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const getToken = vi.fn().mockResolvedValue("dynamic_token");
    const sender = makeSender(fetchMock as unknown as typeof fetch, getToken);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(getToken).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dynamic_token");
  });

  it("sends the MIME message as base64url in `raw`, not standard base64", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(typeof body.raw).toBe("string");
    // base64url never contains these standard-base64-only characters.
    expect(body.raw).not.toMatch(/[+/=]/);
  });

  it("sends threadId alongside raw when supplied, so the reply threads", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "Re: hello",
      html: "<p>hi</p>",
      threadId: "thread-123",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect(body.threadId).toBe("thread-123");
    expect(typeof body.raw).toBe("string");
  });

  it("omits threadId when not supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "hello",
      html: "<p>hi</p>",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    expect("threadId" in body).toBe(false);
  });

  it("carries subject, from, to, cc, html and text into the MIME message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: '"Alice" <a@b.com>',
      to: "c@d.com",
      cc: ["e@f.com"],
      subject: "hello world",
      html: "<p>hi there</p>",
      text: "hi there plain",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const raw = decodeMimeEncodedWords(decodeBase64Url(body.raw));
    expect(raw).toContain("hello world");
    expect(raw).toContain("a@b.com");
    expect(raw).toContain("Alice");
    expect(raw).toContain("c@d.com");
    expect(raw).toContain("e@f.com");
    expect(raw).toContain("hi there plain");
    expect(raw).toContain("<p>hi there</p>");
  });

  it("classifies a 429 as transient", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 429, message: "Rate limit exceeded" },
        }),
        { status: 429 },
      ),
    );
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.transient).toBe(true);
    expect(result.error?.message).toBe("Rate limit exceeded");
  });

  it("classifies a 5xx as transient", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "backend error" } }), {
        status: 503,
      }),
    );
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.error?.transient).toBe(true);
  });

  it("classifies a 400 as terminal (not transient)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 400, message: "Invalid To header" },
        }),
        { status: 400 },
      ),
    );
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "not-an-email",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.transient).toBe(false);
    expect(result.error?.message).toBe("Invalid To header");
  });

  it("treats a 2xx response with an unparsable (e.g. HTML) body as transient", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("<html>Service Unavailable</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    const result = await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "s",
      html: "<p>h</p>",
    });

    expect(result.id).toBeNull();
    expect(result.error?.transient).toBe(true);
  });

  it("returns Gmail's 25MB attachment limit, not Cloudflare's", () => {
    const sender = makeSender(vi.fn() as unknown as typeof fetch);
    expect(sender.maxAttachmentBytes()).toBe(25 * 1024 * 1024);
  });
});
