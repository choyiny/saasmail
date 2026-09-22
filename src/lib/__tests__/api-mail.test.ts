import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMailbox,
  deleteMailbox,
  fetchMailboxes,
  fetchMessages,
  renameMailbox,
  setMailboxMembership,
  setMessageState,
  snoozeMessages,
} from "../api";

describe("mail api client", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        mailboxes: [],
        success: true,
        conversations: 1,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends mailbox and message-state requests with the server contract", async () => {
    await fetchMessages({
      inbox: "team@example.com",
      folder: "snoozed",
      starred: true,
      includeTrashed: false,
      includeSpam: false,
    });
    await fetchMailboxes("team@example.com");
    await createMailbox({
      inbox: "team@example.com",
      name: "VIP",
      parentId: null,
    });
    await renameMailbox("folder/1", "Priority");
    await deleteMailbox("folder/1");
    await setMailboxMembership({
      refs: ["received:e1"],
      add: ["folder/1"],
      remove: ["folder/2"],
    });
    await snoozeMessages(["received:e1"], 1_800_000_000);
    await setMessageState({ refs: ["received:e1"], trashed: true });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/messages?inbox=team%40example.com&folder=snoozed&starred=true&includeTrashed=false&includeSpam=false",
      { credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/mailboxes?inbox=team%40example.com",
      { credentials: "include" },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/mailboxes", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inbox: "team@example.com",
        name: "VIP",
        parentId: null,
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/mailboxes/folder%2F1", {
      credentials: "include",
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Priority" }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(5, "/api/mailboxes/folder%2F1", {
      credentials: "include",
      method: "DELETE",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      6,
      "/api/messages/mailbox-membership",
      {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refs: ["received:e1"],
          add: ["folder/1"],
          remove: ["folder/2"],
        }),
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(7, "/api/messages/snooze", {
      credentials: "include",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        refs: ["received:e1"],
        until: 1_800_000_000,
      }),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      8,
      "/api/messages/mailbox-state",
      {
        credentials: "include",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          refs: ["received:e1"],
          trashed: true,
        }),
      },
    );
  });

  it("surfaces the server error message", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: "A mailbox with that name already exists" }),
    });

    await expect(
      createMailbox({ inbox: "team@example.com", name: "VIP" }),
    ).rejects.toThrow("A mailbox with that name already exists");
  });
});
