import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import ConnectedMailboxes from "@/components/ConnectedMailboxes";
import {
  fetchGmailAccounts,
  disconnectGmailAccount,
  gmailConnectUrl,
  type GmailAccount,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchGmailAccounts: vi.fn(),
  disconnectGmailAccount: vi.fn(),
  gmailConnectUrl: vi.fn(() => "/api/admin/gmail/connect"),
}));

const mFetch = vi.mocked(fetchGmailAccounts);
const mDisconnect = vi.mocked(disconnectGmailAccount);
const mConnectUrl = vi.mocked(gmailConnectUrl);

/** Relative to real "now" so the component's own clock agrees with ours. */
const minutesAgo = (n: number) => Date.now() - n * 60_000;

const account = (over: Partial<GmailAccount> = {}): GmailAccount => ({
  id: "acct_1",
  emailAddress: "ops@example.com",
  lastSyncedAt: minutesAgo(5),
  lastError: null,
  lastGapAt: null,
  createdAt: minutesAgo(60 * 24),
  ...over,
});

beforeEach(() => {
  mFetch.mockReset().mockResolvedValue([]);
  mDisconnect.mockReset().mockResolvedValue({ success: true });
  mConnectUrl.mockReset().mockReturnValue("/api/admin/gmail/connect");
});

describe("ConnectedMailboxes", () => {
  it("renders a connected mailbox's address and a relative synced time", async () => {
    mFetch.mockResolvedValue([account()]);
    render(<ConnectedMailboxes />);

    expect(await screen.findByText("ops@example.com")).toBeTruthy();
    const row = screen.getByTestId("gmail-account-acct_1");
    expect(row.textContent).toContain("5 minutes ago");
    // "Never synced" is a different, explicit state — not this one.
    expect(row.textContent).not.toContain("Not synced yet");
  });

  it("shows Not synced yet, and says sync runs every 15 minutes", async () => {
    mFetch.mockResolvedValue([account({ lastSyncedAt: null })]);
    render(<ConnectedMailboxes />);

    const row = await screen.findByTestId("gmail-account-acct_1");
    expect(row.textContent).toContain("Not synced yet");
    expect(screen.getByText(/every 15 minutes/i)).toBeTruthy();
  });

  it("offers Reconnect and shows the message when lastError is set", async () => {
    mFetch.mockResolvedValue([
      account({
        lastError: "invalid_grant: token has been expired or revoked",
      }),
    ]);
    render(<ConnectedMailboxes />);

    const row = await screen.findByTestId("gmail-account-acct_1");
    // The error text itself, verbatim — not a generic "something went wrong".
    expect(row.textContent).toContain(
      "invalid_grant: token has been expired or revoked",
    );
    // A Reconnect affordance pointing back at the consent screen.
    const reconnect = screen.getByRole("link", { name: /reconnect/i });
    expect(reconnect.getAttribute("href")).toBe("/api/admin/gmail/connect");
    // And it must say the mailbox has stopped syncing until it is reconnected.
    expect(row.textContent).toMatch(/stopped syncing/i);
  });

  it("does not offer Reconnect for a healthy mailbox", async () => {
    mFetch.mockResolvedValue([account()]);
    render(<ConnectedMailboxes />);

    await screen.findByTestId("gmail-account-acct_1");
    expect(screen.queryByRole("link", { name: /reconnect/i })).toBeNull();
  });

  it("warns that mail in a sync gap was never synced and cannot be recovered", async () => {
    mFetch.mockResolvedValue([account({ lastGapAt: minutesAgo(60) })]);
    render(<ConnectedMailboxes />);

    const row = await screen.findByTestId("gmail-account-acct_1");
    expect(row.textContent).toMatch(/never synced/i);
    expect(row.textContent).toMatch(/cannot be recovered/i);
  });

  it("shows no gap warning when lastGapAt is null", async () => {
    mFetch.mockResolvedValue([account()]);
    render(<ConnectedMailboxes />);

    const row = await screen.findByTestId("gmail-account-acct_1");
    expect(row.textContent).not.toMatch(/cannot be recovered/i);
  });

  it("confirms, then disconnects that account by id and removes its row", async () => {
    // Two accounts: a test that renders only one cannot tell "the right id"
    // apart from "the first id".
    mFetch.mockResolvedValue([
      account({ id: "acct_1", emailAddress: "first@example.com" }),
      account({ id: "acct_2", emailAddress: "second@example.com" }),
    ]);
    render(<ConnectedMailboxes />);

    await screen.findByTestId("gmail-account-acct_2");

    // Step 1: Disconnect must NOT call the API — it arms an inline confirm.
    // (No window.confirm: a native dialog blocks jsdom and the browser.)
    fireEvent.click(screen.getByTestId("gmail-disconnect-acct_2"));
    expect(mDisconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId("gmail-account-acct_2")).toBeTruthy();

    // Step 2: confirming calls the API with the SECOND account's id.
    fireEvent.click(screen.getByTestId("gmail-confirm-disconnect-acct_2"));
    await waitFor(() => expect(mDisconnect).toHaveBeenCalledTimes(1));
    expect(mDisconnect).toHaveBeenCalledWith("acct_2");
    expect(mDisconnect).not.toHaveBeenCalledWith("acct_1");

    // The confirmed row goes; the other one stays.
    await waitFor(() =>
      expect(screen.queryByTestId("gmail-account-acct_2")).toBeNull(),
    );
    expect(screen.getByTestId("gmail-account-acct_1")).toBeTruthy();
    expect(screen.getByText("first@example.com")).toBeTruthy();
  });

  it("explains what connecting does when no mailbox is connected", async () => {
    mFetch.mockResolvedValue([]);
    render(<ConnectedMailboxes />);

    const empty = await screen.findByTestId("gmail-empty-state");
    // Connecting does not backfill — say so, or it gets filed as a bug.
    expect(empty.textContent).toMatch(/backfill/i);
    expect(empty.textContent).toMatch(/going forward/i);
    expect(
      screen.getByRole("link", { name: /connect a google mailbox/i }),
    ).toBeTruthy();
  });

  it("shows an error, not an empty list, when loading the accounts fails", async () => {
    mFetch.mockRejectedValue(new Error("API error: 500"));
    render(<ConnectedMailboxes />);

    expect(await screen.findByTestId("gmail-load-error")).toBeTruthy();
    // Must not be mistaken for "you have no mailboxes connected".
    expect(screen.queryByTestId("gmail-empty-state")).toBeNull();
  });
});
