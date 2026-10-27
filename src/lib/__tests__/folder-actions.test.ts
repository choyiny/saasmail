import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyToFolder,
  applyToRefs,
  deleteFolderForever,
  markFolderRead,
} from "@/lib/folder-actions";
import {
  fetchGroupedIds,
  markConversationsRead,
  markPeopleRead,
  updateMailState,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchGroupedIds: vi.fn(),
  markPeopleRead: vi.fn(),
  markConversationsRead: vi.fn(),
  updateMailState: vi.fn(),
}));

const mIds = vi.mocked(fetchGroupedIds);
const mPeopleRead = vi.mocked(markPeopleRead);
const mConvRead = vi.mocked(markConversationsRead);
const mState = vi.mocked(updateMailState);

type Row = { type: "person" | "group"; id: string; unread: boolean };
function rows(people: number, groups: number): Row[] {
  return [
    ...Array.from({ length: people }, (_, i) => ({
      type: "person" as const,
      id: `p${i}`,
      unread: true,
    })),
    ...Array.from({ length: groups }, (_, i) => ({
      type: "group" as const,
      id: `g${i}`,
      unread: true,
    })),
  ];
}

beforeEach(() => {
  mIds.mockReset();
  mPeopleRead.mockReset().mockResolvedValue(undefined as never);
  mConvRead.mockReset().mockResolvedValue(undefined as never);
  mState.mockReset().mockResolvedValue({ data: [] });
});

describe("markFolderRead", () => {
  it("asks for the unread rows of the folder + filters, not the page", async () => {
    mIds.mockResolvedValue({ data: rows(3, 2), total: 5, truncated: false });
    const n = await markFolderRead({
      folder: "inbox",
      recipient: "support@acme.dev",
      category: "promotions",
    });
    expect(mIds).toHaveBeenCalledWith({
      folder: "inbox",
      recipient: "support@acme.dev",
      category: "promotions",
      unread: true,
    });
    expect(n).toBe(5);
    expect(mPeopleRead).toHaveBeenCalledWith(["p0", "p1", "p2"]);
    expect(mConvRead).toHaveBeenCalledWith(["g0", "g1"]);
  });

  it("splits big folders into calls of 100", async () => {
    mIds.mockResolvedValue({
      data: rows(250, 0),
      total: 250,
      truncated: false,
    });
    await markFolderRead({ folder: "inbox" });
    expect(mPeopleRead).toHaveBeenCalledTimes(3);
    expect(mPeopleRead.mock.calls.map((c) => c[0].length)).toEqual([
      100, 100, 50,
    ]);
    expect(mConvRead).not.toHaveBeenCalled();
  });
});

describe("applyToFolder / applyToRefs", () => {
  it("patches every matching row and returns them for Undo", async () => {
    mIds.mockResolvedValue({
      data: rows(120, 1),
      total: 121,
      truncated: false,
    });
    const refs = await applyToFolder({ folder: "inbox" }, { trashed: true });
    expect(refs).toHaveLength(121);
    expect(refs[0]).toEqual({ type: "person", id: "p0" });
    expect(mState).toHaveBeenCalledTimes(2);
    expect(mState.mock.calls[0][1]).toEqual({ trashed: true });

    mState.mockClear();
    await applyToRefs(refs, { trashed: false });
    expect(mState).toHaveBeenCalledTimes(2);
    expect(mState.mock.calls[1][0]).toHaveLength(21);
    expect(mState.mock.calls[1][0].at(-1)).toEqual({ type: "group", id: "g0" });
  });
});

describe("deleteFolderForever (Empty Trash)", () => {
  it("deletes people only and counts the groups it has to leave", async () => {
    mIds.mockResolvedValue({ data: rows(5, 2), total: 7, truncated: false });
    const del = vi.fn().mockResolvedValue({ success: true });
    const res = await deleteFolderForever({ folder: "trash" }, del);
    expect(mIds).toHaveBeenCalledWith({ folder: "trash" });
    expect(del).toHaveBeenCalledTimes(5);
    expect(del.mock.calls.map((c) => c[0])).toEqual([
      "p0",
      "p1",
      "p2",
      "p3",
      "p4",
    ]);
    expect(res).toEqual({ deleted: 5, failed: 0, skippedGroups: 2 });
  });

  it("keeps going when one delete fails, and reports it", async () => {
    mIds.mockResolvedValue({ data: rows(3, 0), total: 3, truncated: false });
    const del = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("Forbidden"))
      .mockResolvedValueOnce({});
    const res = await deleteFolderForever({ folder: "trash" }, del);
    expect(res).toEqual({ deleted: 2, failed: 1, skippedGroups: 0 });
  });
});
