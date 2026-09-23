import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { replyToEmail, sendEmail, fetchStats } from "@/lib/api";
import { serverErrorMessage } from "@/lib/error-message";

/**
 * Every call in the app goes through `apiFetch`. It used to throw away the
 * response body and throw `API error: <status>`, which meant the one failure
 * whose wording changes what the user must do — a Gmail reply that was NOT
 * queued and has to be sent again — arrived at the UI as a number.
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

const GMAIL_502 =
  "Gmail did not accept this reply, and it was not queued for retry: " +
  "Invalid To header. Send it again to retry.";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch error messages", () => {
  it("throws the server's message verbatim when the body carries one", async () => {
    fetchMock.mockResolvedValue(respond(502, { error: GMAIL_502 }));

    await expect(
      replyToEmail("em_1", { fromAddress: "a@b.dev" }),
    ).rejects.toThrowError(GMAIL_502);
  });

  it("throws the message, not the status code, for a plain send too", async () => {
    fetchMock.mockResolvedValue(
      respond(400, { error: "Recipient suppressed." }),
    );

    await expect(
      sendEmail({
        to: "b@c.dev",
        fromAddress: "a@b.dev",
        subject: "hi",
        bodyHtml: "<p>hi</p>",
      }),
    ).rejects.toThrowError("Recipient suppressed.");
  });

  it("falls back to the status code when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(
      respond(502, "<html>bad gateway</html>", false),
    );

    await expect(fetchStats()).rejects.toThrowError("API error: 502");
  });

  it("falls back to the status code when the body is empty", async () => {
    fetchMock.mockResolvedValue(respond(500, undefined, false));

    await expect(fetchStats()).rejects.toThrowError("API error: 500");
  });

  it("falls back to the status code when the JSON has no error field", async () => {
    fetchMock.mockResolvedValue(respond(404, { ok: false, detail: "nope" }));

    await expect(fetchStats()).rejects.toThrowError("API error: 404");
  });

  it("falls back to the status code when the error field is blank or not a string", async () => {
    fetchMock.mockResolvedValue(respond(400, { error: "   " }));
    await expect(fetchStats()).rejects.toThrowError("API error: 400");

    fetchMock.mockResolvedValue(respond(400, { error: 42 }));
    await expect(fetchStats()).rejects.toThrowError("API error: 400");
  });

  it("still returns the parsed body on success", async () => {
    fetchMock.mockResolvedValue(
      respond(200, {
        totalPeople: 3,
        totalEmails: 9,
        unreadCount: 1,
        recipients: [],
        senderIdentities: [],
      }),
    );

    await expect(fetchStats()).resolves.toMatchObject({ totalPeople: 3 });
  });
});

describe("serverErrorMessage", () => {
  it("returns a real server explanation", () => {
    expect(serverErrorMessage(new Error(GMAIL_502))).toBe(GMAIL_502);
  });

  it("returns null for the bare status-code fallback", () => {
    expect(serverErrorMessage(new Error("API error: 502"))).toBeNull();
    expect(serverErrorMessage(new Error("API error: 400"))).toBeNull();
  });

  it("returns null for an empty or non-Error failure", () => {
    expect(serverErrorMessage(new Error("  "))).toBeNull();
    expect(serverErrorMessage(undefined)).toBeNull();
    expect(serverErrorMessage({ error: "nope" })).toBeNull();
  });

  it("keeps a message that merely mentions an API error", () => {
    expect(
      serverErrorMessage(new Error("API error: 502 while calling Gmail")),
    ).toBe("API error: 502 while calling Gmail");
  });
});
