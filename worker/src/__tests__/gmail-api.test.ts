import { describe, it, expect, vi, afterEach } from "vitest";
import {
  listHistory,
  getMessage,
  listSendAs,
  GmailApiError,
} from "../lib/gmail/api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stub(status: number, body: unknown) {
  const fn = vi.fn(
    async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

describe("listHistory", () => {
  it("collects added message ids across a history page", async () => {
    stub(200, {
      history: [
        { id: "9001", messagesAdded: [{ message: { id: "m1" } }] },
        {
          id: "9002",
          messagesAdded: [{ message: { id: "m2" } }, { message: { id: "m3" } }],
        },
      ],
      historyId: "9002",
    });

    const res = await listHistory("at", { startHistoryId: "9000" });
    expect(res.added.map((a) => a.messageId)).toEqual(["m1", "m2", "m3"]);
    // Each message carries its OWN enclosing record's id, not the page-level
    // historyId. This is the whole point: m1 must stay pinned to 9001, so a
    // run that stops after m1 resumes at 9002 rather than skipping m2 and m3.
    expect(res.added).toEqual([
      { messageId: "m1", historyId: "9001" },
      { messageId: "m2", historyId: "9002" },
      { messageId: "m3", historyId: "9002" },
    ]);
    expect(res.historyId).toBe("9002");
    expect(res.nextPageToken).toBeNull();
  });

  it("stalls rather than drop a history record with no usable id", async () => {
    stub(200, {
      history: [
        { messagesAdded: [{ message: { id: "orphan" } }] },
        { id: "9003", messagesAdded: [{ message: { id: "m1" } }] },
      ],
      historyId: "9003",
    });

    // Skipping the record would leave the rest of the page looking complete,
    // so the cursor would advance past mail we never fetched. Stalling is the
    // safe failure; losing mail is not.
    const err = await listHistory("at", { startHistoryId: "9000" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.code).toBe("malformed_history");
    expect(err.message).toContain("index 0");
  });

  it("stalls rather than drop a messagesAdded entry with no message id", async () => {
    stub(200, {
      history: [
        {
          id: "9004",
          messagesAdded: [{ message: { id: "m1" } }, { message: {} }],
        },
      ],
      historyId: "9004",
    });

    // The subtler half: the record would otherwise look complete and become a
    // legal resume point, stranding the message whose id was missing.
    const err = await listHistory("at", { startHistoryId: "9000" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.code).toBe("malformed_history");
    expect(err.message).toContain("record 9004");
  });

  it("coerces a numeric record id to a string", async () => {
    stub(200, {
      history: [{ id: 9004, messagesAdded: [{ message: { id: "m1" } }] }],
      historyId: 9004,
    });

    const res = await listHistory("at", { startHistoryId: "9000" });
    expect(res.added).toEqual([{ messageId: "m1", historyId: "9004" }]);
    expect(res.historyId).toBe("9004");
  });

  it("returns an empty list when nothing changed", async () => {
    stub(200, { historyId: "9000" });
    const res = await listHistory("at", { startHistoryId: "9000" });
    expect(res.added).toEqual([]);
  });

  it("surfaces the page token so the caller can continue", async () => {
    stub(200, { history: [], historyId: "9001", nextPageToken: "tok" });
    const res = await listHistory("at", { startHistoryId: "9000" });
    expect(res.nextPageToken).toBe("tok");
  });

  it("passes startHistoryId and pageToken on the query string", async () => {
    const fn = stub(200, { historyId: "1" });
    await listHistory("at", { startHistoryId: "9000", pageToken: "tok" });
    const url = new URL(String(fn.mock.calls[0][0]));
    expect(url.searchParams.get("startHistoryId")).toBe("9000");
    expect(url.searchParams.get("pageToken")).toBe("tok");
    expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
  });

  it("reports an expired cursor as history_gone", async () => {
    stub(404, { error: { message: "Requested entity was not found." } });
    const err = await listHistory("at", { startHistoryId: "1" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.code).toBe("history_gone");
    expect(err.status).toBe(404);
  });

  it("reports a 429 as rate_limited", async () => {
    stub(429, { error: { message: "Rate Limit Exceeded" } });
    const err = await listHistory("at", { startHistoryId: "1" }).catch(
      (e) => e,
    );
    expect(err.code).toBe("rate_limited");
  });

  it("reports a non-JSON error body as http_500", async () => {
    stub(500, "<html>upstream is sad</html>");
    const err = await listHistory("at", { startHistoryId: "1" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.code).toBe("http_500");
  });

  it("handles HTTP 200 with malformed JSON body on success path", async () => {
    stub(200, "<html>not json</html>");
    const res = await listHistory("at", { startHistoryId: "9000" });
    expect(res.added).toEqual([]);
    expect(res.nextPageToken).toBeNull();
    expect(res.historyId).toBeNull();
  });
});

describe("getMessage", () => {
  it("decodes base64url raw bytes and returns labels", async () => {
    const raw = "From: a@b.test\r\n\r\nhello";
    const b64url = btoa(raw)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    stub(200, { id: "m1", threadId: "t1", labelIds: ["INBOX"], raw: b64url });

    const msg = await getMessage("at", "m1");
    expect(msg).not.toBeNull();
    expect(new TextDecoder().decode(msg!.raw)).toBe(raw);
    expect(msg!.labelIds).toEqual(["INBOX"]);
    expect(msg!.threadId).toBe("t1");
  });

  it("returns null when the message is gone", async () => {
    stub(404, { error: { message: "Not Found" } });
    expect(await getMessage("at", "m1")).toBeNull();
  });

  it("requests format=raw", async () => {
    const fn = stub(200, { id: "m1", threadId: "t1", labelIds: [], raw: "" });
    await getMessage("at", "m1");
    const url = new URL(String(fn.mock.calls[0][0]));
    expect(url.searchParams.get("format")).toBe("raw");
  });

  it("throws for a non-404 failure", async () => {
    stub(500, { error: { message: "boom" } });
    await expect(getMessage("at", "m1")).rejects.toBeInstanceOf(GmailApiError);
  });

  it("handles HTTP 200 with malformed JSON body on success path", async () => {
    stub(200, "<html>not json</html>");
    const msg = await getMessage("at", "m1");
    expect(msg).not.toBeNull();
    expect(new TextDecoder().decode(msg!.raw)).toBe("");
    expect(msg!.labelIds).toEqual([]);
    expect(msg!.threadId).toBe("");
  });
});

describe("listSendAs", () => {
  it("returns every sendAs address, trimmed and lowercased", async () => {
    const fn = stub(200, {
      sendAs: [
        { sendAsEmail: "Collector@Acme.DEV", isPrimary: true },
        { sendAsEmail: "  Support@Acme.dev  " },
        { displayName: "no address at all" },
      ],
    });

    // Callers compare against a stored inbox address; normalising here is what
    // stops a correct mapping being rejected over letter case.
    expect(await listSendAs("at")).toEqual([
      "collector@acme.dev",
      "support@acme.dev",
    ]);
    expect(String(fn.mock.calls[0][0])).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs",
    );
  });

  it("throws a GmailApiError on a non-2xx without echoing the token", async () => {
    stub(403, { error: { message: "insufficient permissions" } });
    const err = await listSendAs("super-secret-token").catch((e) => e);
    expect(err).toBeInstanceOf(GmailApiError);
    expect(err.status).toBe(403);
    expect(err.message).not.toContain("super-secret-token");
  });

  it("returns an empty list when the body has no sendAs array", async () => {
    stub(200, "<html>not json</html>");
    expect(await listSendAs("at")).toEqual([]);
  });
});
