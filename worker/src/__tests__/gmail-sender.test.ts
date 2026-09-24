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

  it("keeps every Cc recipient when several are supplied, not just the last", async () => {
    // mimetext's setCc() REPLACES the Cc header rather than appending, so
    // calling it once per address in a loop would silently drop all but
    // the last recipient. This pins the fix: build the array once, call
    // setCc once, and every address survives into `raw`.
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    await sender.send({
      from: "a@b.com",
      to: "d@d.com",
      cc: ["one@example.com", "two@example.com", "three@example.com"],
      subject: "s",
      html: "<p>h</p>",
    });

    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    // Display names are RFC2047-encoded by mimetext, so assert on the bare
    // addresses (what actually matters for delivery) rather than a literal
    // "Name <addr>" string.
    const raw = decodeMimeEncodedWords(decodeBase64Url(body.raw));
    expect(raw).toContain("one@example.com");
    expect(raw).toContain("two@example.com");
    expect(raw).toContain("three@example.com");
  });

  it("carries an attachment into the raw message Gmail receives", async () => {
    // Nothing exercised the addAttachment loop on this transport before:
    // the reply route sized attachments with the CONFIGURED provider, so on
    // a Gmail-only install every attachment 413'd before it reached here.
    const fetchMock = vi.fn().mockResolvedValue(okResponse({ id: "1" }));
    const sender = makeSender(fetchMock as unknown as typeof fetch);

    // Bytes chosen so their base64 is distinctive and cannot collide with
    // anything mimetext emits on its own.
    const content = new TextEncoder().encode("invoice-contents-42");
    const expectedB64 = btoa("invoice-contents-42");

    const result = await sender.send({
      from: "a@b.com",
      to: "d@d.com",
      subject: "s",
      html: "<p>h</p>",
      attachments: [
        { filename: "invoice.pdf", contentType: "application/pdf", content },
      ],
    });

    expect(result.error).toBeNull();
    const body = JSON.parse(
      (fetchMock.mock.calls[0][1] as RequestInit).body as string,
    );
    const raw = decodeMimeEncodedWords(decodeBase64Url(body.raw));
    // The filename, the declared type, and the actual bytes — asserting only
    // the filename would still pass if the content were dropped.
    expect(raw).toContain("invoice.pdf");
    expect(raw).toContain("application/pdf");
    expect(raw.replace(/\r?\n/g, "")).toContain(expectedB64);
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

  it("keeps a failed re-authorization's own error text out of the reply's error", async () => {
    // `reauthorize` is `invalidateAccessToken` + `getAccessToken`, and
    // `getAccessToken` ends in a D1 UPDATE whose bound parameters are the
    // plaintext access token and the SEALED refresh token. A D1 error carries
    // the parameters bound to it, and this message becomes a 502 body that
    // any authenticated user holding a permission on the inbox can read —
    // not only an admin. So none of it may be interpolated, whatever it says.
    const leak = new Error(
      "D1_ERROR: UPDATE gmail_accounts SET access_token = 'ya29.SECRET-AT', " +
        "refresh_token_encrypted = 'SEALED-RT'",
    );
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: "Invalid Credentials" } }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    const sender = new GmailSender(
      "gm_test_token",
      fetchMock as unknown as typeof fetch,
      {
        accountId: "acct-1",
        reauthorize: async () => {
          throw leak;
        },
      },
    );

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let result;
    let logged: string;
    try {
      result = await sender.send({
        from: "a@b.com",
        to: "c@d.com",
        subject: "s",
        html: "<p>h</p>",
      });
    } finally {
      // Read the calls BEFORE restoring: `mockRestore` resets the mock's
      // recorded calls, which would leave every log assertion below vacuously
      // true against an empty string.
      logged = errorSpy.mock.calls.flat().join(" ");
      errorSpy.mockRestore();
    }

    expect(result.id).toBeNull();
    expect(result.error?.reconnect).toBe(true);
    // What the user needs is the action, and it is still there.
    expect(result.error?.message).toMatch(/reconnect this mailbox/i);
    // What they must never get is any of the thrown text.
    expect(result.error?.message).not.toContain("SECRET-AT");
    expect(result.error?.message).not.toContain("SEALED-RT");
    expect(result.error?.message).not.toMatch(/D1_ERROR|gmail_accounts/i);
    // The log gets a code, not the error and not its message.
    expect(logged).toContain("reauthorize_failed");
    expect(logged).not.toContain("SECRET-AT");
    expect(logged).not.toContain("SEALED-RT");
  });

  it("budgets Gmail's 25MB message limit against the ENCODED size", () => {
    const sender = makeSender(vi.fn() as unknown as typeof fetch);
    const limit = sender.maxAttachmentBytes();

    // Not the flat 25 MB: messages.send carries the whole MIME message
    // base64url-encoded in JSON, and the attachment is already base64 inside
    // that message, so an attachment costs ~1.78x its own size on the wire.
    // A flat budget would let through a request Gmail rejects — on the path
    // that is never queued, so the user cannot retry past it.
    expect(limit).toBeLessThan(25 * 1024 * 1024);
    // An attachment at exactly the limit must still fit inside 25 MB once
    // both encodings are applied. This is the property that matters; the
    // exact byte count is an implementation detail.
    expect(limit * (4 / 3) * (4 / 3)).toBeLessThanOrEqual(25 * 1024 * 1024);
    // And it must not be so conservative as to be useless — a 10 MB
    // attachment still has to be sendable through Gmail.
    expect(limit).toBeGreaterThan(10 * 1024 * 1024);
  });
});
