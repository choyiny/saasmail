import { describe, expect, it, vi } from "vitest";
import { latestAllowedInboxForPerson } from "../lib/agent/crm";

describe("latestAllowedInboxForPerson", () => {
  it("pushes visibility into SQL and bounds the lookup to one row", async () => {
    const limit = vi
      .fn()
      .mockResolvedValue([{ recipient: "allowed@example.com" }]);
    const orderBy = vi.fn(() => ({ limit }));
    const where = vi.fn(() => ({ orderBy }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const db = { select } as any;

    await expect(
      latestAllowedInboxForPerson(db, "person-1", {
        isAdmin: false,
        inboxes: ["allowed@example.com"],
      }),
    ).resolves.toBe("allowed@example.com");

    expect(where).toHaveBeenCalledTimes(1);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("keeps the existing no-permitted-inbox error", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const db = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            orderBy: vi.fn(() => ({ limit })),
          })),
        })),
      })),
    } as any;

    await expect(
      latestAllowedInboxForPerson(db, "person-1", {
        isAdmin: false,
        inboxes: [],
      }),
    ).rejects.toThrow("No permitted inbox is available for this person");
  });
});
