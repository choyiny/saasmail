import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { updateInboxSettings } from "@/lib/api";

/**
 * The Gmail-source PATCH is the one call whose failure body is the whole
 * point: the server answers 400 naming the address the mailbox can't send
 * as, 502 when it couldn't check, 503 when Gmail isn't configured. If this
 * layer flattens those to "API error: 400", the admin is told something
 * broke and nothing about how to fix it.
 */
function respond(status: number, body: unknown, json = true) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (!json) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("updateInboxSettings", () => {
  it("sends the patch, including an explicit null mailbox id", async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        email: "sales@acme.dev",
        displayName: null,
        displayMode: "chat",
        signatureHtml: null,
        forwardTo: null,
        source: "cloudflare",
        gmailAccountId: null,
      }),
    );

    const res = await updateInboxSettings("sales@acme.dev", {
      source: "cloudflare",
      gmailAccountId: null,
    });

    expect(res.source).toBe("cloudflare");
    expect(res.gmailAccountId).toBeNull();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/admin/inboxes/sales%40acme.dev");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({
      source: "cloudflare",
      gmailAccountId: null,
    });
  });

  it("throws the server's rejection message word for word", async () => {
    const serverMessage =
      'ops@gmail.test cannot send as support@acme.dev. Add it under Gmail’s "Send mail as", then map this inbox again.';
    fetchMock.mockResolvedValue(respond(400, { error: serverMessage }));

    await expect(
      updateInboxSettings("support@acme.dev", {
        source: "gmail",
        gmailAccountId: "acct_ops",
      }),
    ).rejects.toThrowError(serverMessage);
  });

  it("falls back to the status code when the body carries no message", async () => {
    fetchMock.mockResolvedValue(respond(502, null, false));

    await expect(
      updateInboxSettings("support@acme.dev", { source: "gmail" }),
    ).rejects.toThrowError("API error: 502");
  });
});
