import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  waitFor,
  fireEvent,
  within,
} from "@testing-library/react";
import AdminInboxTable from "@/components/AdminInboxTable";
import {
  fetchAdminInboxes,
  fetchAdminUsers,
  fetchGmailAccounts,
  updateInboxSettings,
  type AdminInbox,
  type GmailAccount,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchAdminInboxes: vi.fn(),
  fetchAdminUsers: vi.fn(),
  fetchGmailAccounts: vi.fn(),
  updateInboxSettings: vi.fn(),
  updateInboxAssignments: vi.fn(),
  createInbox: vi.fn(),
  deleteInbox: vi.fn(),
}));

// The signature editor pulls in Tiptap/ProseMirror, which has nothing to do
// with the Source control and is slow to boot in jsdom.
vi.mock("@/components/TiptapEditor", () => ({
  default: () => <div data-testid="tiptap-stub" />,
}));

const mInboxes = vi.mocked(fetchAdminInboxes);
const mUsers = vi.mocked(fetchAdminUsers);
const mAccounts = vi.mocked(fetchGmailAccounts);
const mUpdate = vi.mocked(updateInboxSettings);

const inbox = (over: Partial<AdminInbox> & { email: string }): AdminInbox => ({
  displayName: null,
  displayMode: "chat",
  signatureHtml: null,
  forwardTo: null,
  assignedUserIds: [],
  source: "cloudflare",
  gmailAccountId: null,
  ...over,
});

const gmailAccount = (
  over: Partial<GmailAccount> & { id: string; emailAddress: string },
): GmailAccount => ({
  lastSyncedAt: null,
  lastError: null,
  lastGapAt: null,
  // Unix seconds, like the worker writes — not milliseconds.
  createdAt: 1_700_000_000,
  ...over,
});

/**
 * Three inboxes and two connected mailboxes on purpose: a control that always
 * acted on the first row, or always sent the first account's id, would still
 * pass a one-row / one-account fixture.
 */
const BILLING = "billing@acme.dev";
const SUPPORT = "support@acme.dev";
const SALES = "sales@acme.dev";

const ACCT_OPS = gmailAccount({
  id: "acct_ops",
  emailAddress: "ops@gmail.test",
});
const ACCT_DESK = gmailAccount({
  id: "acct_desk",
  emailAddress: "desk@gmail.test",
});

function seed(over?: { inboxes?: AdminInbox[]; accounts?: GmailAccount[] }) {
  mInboxes.mockResolvedValue(
    over?.inboxes ?? [
      inbox({ email: BILLING }),
      inbox({ email: SUPPORT }),
      inbox({ email: SALES, source: "gmail", gmailAccountId: ACCT_DESK.id }),
    ],
  );
  mAccounts.mockResolvedValue(over?.accounts ?? [ACCT_OPS, ACCT_DESK]);
}

/** Row `<tr>` for an inbox, so assertions can't drift to a neighbouring row. */
async function rowFor(email: string): Promise<HTMLElement> {
  return await waitFor(() => {
    const row = document.querySelector<HTMLElement>(
      `[data-testid="inbox-row"][data-inbox-email="${email}"]`,
    );
    if (!row) throw new Error(`no row for ${email}`);
    return row;
  });
}

async function sourceSelectFor(email: string): Promise<HTMLSelectElement> {
  const row = await rowFor(email);
  return within(row).getByTestId("inbox-source-select") as HTMLSelectElement;
}

/** The option text the admin actually sees in the closed select. */
function selectedLabel(select: HTMLSelectElement): string {
  return select.options[select.selectedIndex]?.textContent?.trim() ?? "";
}

beforeEach(() => {
  mInboxes.mockReset();
  mUsers.mockReset().mockResolvedValue([]);
  mAccounts.mockReset();
  mUpdate.mockReset();
});

describe("AdminInboxTable — Gmail source mapping", () => {
  it("shows Cloudflare for an inbox that isn't mapped to a mailbox", async () => {
    seed();
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SUPPORT);
    expect(select.value).toBe("cloudflare");
    expect(selectedLabel(select)).toBe("Cloudflare");
  });

  it("shows the mapped mailbox's address, not its id", async () => {
    seed();
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SALES);
    expect(selectedLabel(select)).toBe(ACCT_DESK.emailAddress);
    // The id is a storage detail; an admin can't act on it.
    const row = await rowFor(SALES);
    expect(row.textContent).not.toContain(ACCT_DESK.id);
    // ...and it is this inbox's mailbox, not just any connected one.
    expect(selectedLabel(select)).not.toBe(ACCT_OPS.emailAddress);
  });

  it("maps the chosen inbox to the chosen mailbox", async () => {
    seed();
    mUpdate.mockResolvedValue({
      email: SUPPORT,
      displayName: null,
      displayMode: "chat",
      signatureHtml: null,
      forwardTo: null,
      source: "gmail",
      gmailAccountId: ACCT_DESK.id,
    });
    render(<AdminInboxTable />);

    // Second row, second account: a control hard-wired to either "the first
    // one" would pass with a single-row fixture and fails here.
    const select = await sourceSelectFor(SUPPORT);
    fireEvent.change(select, { target: { value: ACCT_DESK.id } });

    await waitFor(() => expect(mUpdate).toHaveBeenCalledTimes(1));
    expect(mUpdate).toHaveBeenCalledWith(SUPPORT, {
      source: "gmail",
      gmailAccountId: ACCT_DESK.id,
    });

    await waitFor(async () =>
      expect((await sourceSelectFor(SUPPORT)).value).toBe(ACCT_DESK.id),
    );
    // The other rows were not touched.
    expect((await sourceSelectFor(BILLING)).value).toBe("cloudflare");
  });

  it("clears the mailbox id when switching back to Cloudflare", async () => {
    seed();
    mUpdate.mockResolvedValue({
      email: SALES,
      displayName: null,
      displayMode: "chat",
      signatureHtml: null,
      forwardTo: null,
      source: "cloudflare",
      gmailAccountId: null,
    });
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SALES);
    fireEvent.change(select, { target: { value: "cloudflare" } });

    await waitFor(() => expect(mUpdate).toHaveBeenCalledTimes(1));
    const [email, patch] = mUpdate.mock.calls[0];
    expect(email).toBe(SALES);
    expect(patch.source).toBe("cloudflare");
    // Explicitly null, not merely absent and not the stale id: a Cloudflare
    // row that still carries a gmailAccountId lies about itself.
    expect("gmailAccountId" in patch).toBe(true);
    expect(patch.gmailAccountId).toBeNull();

    await waitFor(async () =>
      expect(selectedLabel(await sourceSelectFor(SALES))).toBe("Cloudflare"),
    );
  });

  it("shows the server's rejection verbatim and reverts the control", async () => {
    const serverMessage =
      'ops@gmail.test cannot send as support@acme.dev. Add it under Gmail’s "Send mail as", then map this inbox again.';
    seed();
    mUpdate.mockRejectedValue(new Error(serverMessage));
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SUPPORT);
    fireEvent.change(select, { target: { value: ACCT_OPS.id } });

    await waitFor(() => expect(mUpdate).toHaveBeenCalledTimes(1));

    const row = await rowFor(SUPPORT);
    await waitFor(() =>
      expect(within(row).getByTestId("inbox-source-error").textContent).toBe(
        serverMessage,
      ),
    );
    // A generic message here would throw away the one thing the admin can act on.
    expect(screen.queryByText(/failed to update inbox/i)).toBeNull();

    // The row was not changed server-side, so the control must not claim it was.
    const after = await sourceSelectFor(SUPPORT);
    expect(after.value).toBe("cloudflare");
    expect(selectedLabel(after)).toBe("Cloudflare");
  });

  it("offers no mailbox when none is connected, and says to connect one", async () => {
    seed({ accounts: [] });
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SUPPORT);
    const labels = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(labels).not.toContain(ACCT_OPS.emailAddress);
    expect(labels).not.toContain(ACCT_DESK.emailAddress);
    expect(select.disabled).toBe(true);
    expect(
      labels.some((l) => /connect a google mailbox first/i.test(l ?? "")),
    ).toBe(true);
  });
});

describe("AdminInboxTable — re-reading after a mailbox changed", () => {
  it("re-reads both lists when the page signals a change", async () => {
    // The section above this table disconnects a mailbox in place, which also
    // unmaps the inboxes that read from it. Without the re-read the operator
    // keeps being offered a mailbox that no longer exists.
    seed();
    const { rerender } = render(<AdminInboxTable gmailVersion={0} />);
    await sourceSelectFor(SALES);
    expect(mAccounts).toHaveBeenCalledTimes(1);
    expect(mInboxes).toHaveBeenCalledTimes(1);

    mAccounts.mockResolvedValue([ACCT_OPS]);
    mInboxes.mockResolvedValue([
      inbox({ email: BILLING }),
      inbox({ email: SUPPORT }),
      inbox({ email: SALES }),
    ]);
    rerender(<AdminInboxTable gmailVersion={1} />);

    await waitFor(() => expect(mAccounts).toHaveBeenCalledTimes(2));
    expect(mInboxes).toHaveBeenCalledTimes(2);
    // The disconnected mailbox is gone from the options, and the row that
    // pointed at it now reads Cloudflare rather than a dangling id.
    await waitFor(async () =>
      expect(selectedLabel(await sourceSelectFor(SALES))).toBe("Cloudflare"),
    );
    const labels = Array.from((await sourceSelectFor(SUPPORT)).options).map(
      (o) => o.textContent?.trim(),
    );
    expect(labels).not.toContain(ACCT_DESK.emailAddress);
    expect(labels).toContain(ACCT_OPS.emailAddress);
  });

  it("does not re-read the inboxes on first mount", async () => {
    // The initial load already fetched them; a second round trip on every
    // mount is the cost this signal exists to avoid.
    seed();
    render(<AdminInboxTable gmailVersion={0} />);
    await sourceSelectFor(SALES);
    expect(mInboxes).toHaveBeenCalledTimes(1);
  });
});

/**
 * "The mailbox is gone" and "we could not ask" look identical on a closed
 * <select>, and the first one talks the operator into unmapping a working
 * inbox. They must not share a label.
 */
describe("AdminInboxTable — a mapping we could not verify", () => {
  it("does not claim a mapped mailbox is disconnected when the list failed to load", async () => {
    mInboxes.mockResolvedValue([
      inbox({ email: SALES, source: "gmail", gmailAccountId: ACCT_DESK.id }),
    ]);
    mAccounts.mockRejectedValue(new Error("API error: 500"));
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SALES);
    // The visible label — the only text on a closed select — must not assert
    // a disconnection nobody observed.
    expect(selectedLabel(select)).not.toMatch(/no longer connected/i);
    expect(selectedLabel(select)).toMatch(/could ?n.t check/i);
    // And the control is locked, because switching it is a real PATCH that
    // would unmap an inbox that is probably fine.
    expect(select.disabled).toBe(true);
  });

  it("still says a mapping is orphaned when the list loaded without it", async () => {
    // The list came back, and this mapping's mailbox is genuinely not in it.
    mInboxes.mockResolvedValue([
      inbox({ email: SALES, source: "gmail", gmailAccountId: "acct_gone" }),
    ]);
    mAccounts.mockResolvedValue([ACCT_OPS]);
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(SALES);
    expect(selectedLabel(select)).toMatch(/no longer connected/i);
    expect(selectedLabel(select)).not.toMatch(/could ?n.t check/i);
    // This one the operator can and should act on.
    expect(select.disabled).toBe(false);
  });

  it("does not lock an unmapped row when the list failed to load", async () => {
    // Nothing is at stake on a Cloudflare row: there is no mapping to lose.
    mInboxes.mockResolvedValue([inbox({ email: BILLING })]);
    mAccounts.mockRejectedValue(new Error("API error: 500"));
    render(<AdminInboxTable />);

    const select = await sourceSelectFor(BILLING);
    expect(selectedLabel(select)).toBe("Cloudflare");
    const labels = Array.from(select.options).map((o) => o.textContent?.trim());
    expect(
      labels.some((l) => /could ?n.t load connected mailboxes/i.test(l ?? "")),
    ).toBe(true);
  });
});
