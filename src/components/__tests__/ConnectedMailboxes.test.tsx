import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import ConnectedMailboxes from "@/components/ConnectedMailboxes";
import {
  fetchGmailAccounts,
  disconnectGmailAccount,
  startGmailConnect,
  type GmailAccount,
} from "@/lib/api";
import { navigateExternal } from "@/lib/navigate-external";

vi.mock("@/lib/api", () => ({
  fetchGmailAccounts: vi.fn(),
  disconnectGmailAccount: vi.fn(),
  startGmailConnect: vi.fn(),
}));

vi.mock("@/lib/navigate-external", () => ({
  navigateExternal: vi.fn(),
}));

const mFetch = vi.mocked(fetchGmailAccounts);
const mDisconnect = vi.mocked(disconnectGmailAccount);
const mStartConnect = vi.mocked(startGmailConnect);
const mNavigate = vi.mocked(navigateExternal);

/**
 * A realistic consent URL. Distinctive enough that navigating to anything
 * else — the API path, a bare origin — fails the assertion rather than
 * merely "navigation happened".
 */
const CONSENT_URL =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc123.apps.googleusercontent.com&state=signed-state";

/**
 * Relative to real "now", in **unix seconds** — the unit the worker stores
 * and `GET /api/admin/gmail` returns (`nowSeconds` in lib/gmail/sync.ts).
 * A millisecond fixture here would agree with a millisecond bug in the
 * component and assert nothing; it has to state the server's contract.
 */
const minutesAgo = (n: number) => Math.floor(Date.now() / 1000) - n * 60;

const account = (over: Partial<GmailAccount> = {}): GmailAccount => ({
  id: "acct_1",
  emailAddress: "ops@example.com",
  lastSyncedAt: minutesAgo(5),
  lastError: null,
  lastGapAt: null,
  createdAt: minutesAgo(60 * 24),
  connectedBy: { id: "user_1", name: "Jane Ops", email: "jane@example.com" },
  ...over,
});

/** Surfaces the live query string so a test can watch the param be cleared. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

/**
 * The component reads `?gmail=` from the OAuth callback's redirect, so it
 * needs a real router. Render it at a URL rather than bare.
 */
function renderAt(path = "/inboxes") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/inboxes" element={<ConnectedMailboxes />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mFetch.mockReset().mockResolvedValue([]);
  mDisconnect.mockReset().mockResolvedValue({ success: true });
  mStartConnect.mockReset().mockResolvedValue({ authUrl: CONSENT_URL });
  mNavigate.mockReset();
});

describe("ConnectedMailboxes", () => {
  it("renders a connected mailbox's address and a relative synced time", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt();

    expect(await screen.findByText("ops@example.com")).toBeTruthy();
    // The synced line specifically — the row also carries the (legitimately
    // much older) date the mailbox was added.
    const synced = screen.getByTestId("gmail-synced-acct_1");
    expect(synced.textContent).toContain("Synced 5 minutes ago");
    // Reading the seconds the server sends as milliseconds puts every live
    // mailbox ~20698 days in the past, which is what shipped. Any "days ago"
    // at all is wrong for a fixture five minutes old.
    expect(synced.textContent).not.toMatch(/days? ago/);
    // "Never synced" is a different, explicit state — not this one.
    expect(synced.textContent).not.toContain("Not synced yet");
  });

  it("shows Not synced yet, and says sync runs every 15 minutes", async () => {
    mFetch.mockResolvedValue([account({ lastSyncedAt: null })]);
    renderAt();

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
    renderAt();

    const row = await screen.findByTestId("gmail-account-acct_1");
    // The error text itself, verbatim — not a generic "something went wrong".
    expect(row.textContent).toContain(
      "invalid_grant: token has been expired or revoked",
    );
    // A Reconnect affordance. A *button* — an anchor to the API path lands
    // the operator on raw JSON, which is the bug this replaced.
    expect(screen.getByTestId("gmail-reconnect-acct_1")).toBeTruthy();
    // And it must say the mailbox has stopped syncing until it is reconnected.
    expect(row.textContent).toMatch(/stopped syncing/i);
  });

  it("says who last connected the mailbox and when it was added", async () => {
    // A mailbox reads someone else's mail. An operator looking at one they
    // did not set up has to be able to see where it came from without
    // querying the database.
    mFetch.mockResolvedValue([account({ createdAt: minutesAgo(60 * 24 * 3) })]);
    renderAt();

    const provenance = await screen.findByTestId("gmail-provenance-acct_1");
    expect(provenance.textContent).toContain("Jane Ops");
    expect(provenance.textContent).toContain("Added 3 days ago");
  });

  it("still dates a mailbox connected before the server recorded who", async () => {
    mFetch.mockResolvedValue([
      account({ connectedBy: null, createdAt: minutesAgo(60 * 2) }),
    ]);
    renderAt();

    const provenance = await screen.findByTestId("gmail-provenance-acct_1");
    expect(provenance.textContent).toBe("Added 2 hours ago");
  });

  it("names a deleted admin as such rather than printing a user id", async () => {
    // `connected_by` carries no foreign key, so the id outlives the account.
    mFetch.mockResolvedValue([
      account({
        connectedBy: { id: "user_gone", name: null, email: null },
      }),
    ]);
    renderAt();

    const provenance = await screen.findByTestId("gmail-provenance-acct_1");
    expect(provenance.textContent).toContain("a deleted user");
    expect(provenance.textContent).not.toContain("user_gone");
  });

  it("does not offer Reconnect for a healthy mailbox", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt();

    await screen.findByTestId("gmail-account-acct_1");
    expect(screen.queryByTestId("gmail-reconnect-acct_1")).toBeNull();
  });

  it("warns that mail in a sync gap was never synced and cannot be recovered", async () => {
    mFetch.mockResolvedValue([account({ lastGapAt: minutesAgo(60) })]);
    renderAt();

    const row = await screen.findByTestId("gmail-account-acct_1");
    expect(row.textContent).toMatch(/never synced/i);
    expect(row.textContent).toMatch(/cannot be recovered/i);
  });

  it("dates the sync gap from lastGapAt, not from the last sync", async () => {
    // The gap's AGE is the signal (gmail-accounts.schema.ts): "10 minutes ago"
    // means mail is probably still missing, "3 months ago" is history. The two
    // timestamps are deliberately far apart, so printing the wrong one — or
    // reading either as milliseconds — cannot produce this string.
    mFetch.mockResolvedValue([
      account({ lastSyncedAt: minutesAgo(5), lastGapAt: minutesAgo(60) }),
    ]);
    renderAt();

    const row = await screen.findByTestId("gmail-account-acct_1");
    expect(row.textContent).toContain("Sync gap 1 hour ago");
    expect(row.textContent).not.toContain("Sync gap 5 minutes ago");
  });

  it("shows no gap warning when lastGapAt is null", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt();

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
    renderAt();

    await screen.findByTestId("gmail-account-acct_2");

    // Step 1: Disconnect must NOT call the API — it arms an inline confirm.
    // (No window.confirm: a native dialog blocks jsdom and the browser.)
    fireEvent.click(screen.getByTestId("gmail-disconnect-acct_2"));
    expect(mDisconnect).not.toHaveBeenCalled();
    expect(screen.getByTestId("gmail-account-acct_2")).toBeTruthy();

    // The confirm copy must not claim to revoke access at Google — DELETE
    // only drops the stored row. Promising a revocation we never perform is
    // the worst kind of security claim to leave in.
    const confirmCopy = screen.getByTestId("gmail-account-acct_2").textContent;
    expect(confirmCopy).not.toMatch(/revokes saasmail/i);
    expect(confirmCopy).toMatch(/stored credentials|stored token/i);
    expect(confirmCopy).toMatch(/separate step|your Google account/i);

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

  it("tells the page the mailbox set changed, only once the disconnect succeeded", async () => {
    // Disconnecting also unmaps inboxes server-side, so the rest of the page
    // is stale afterwards. Firing before the call returns — or when it fails
    // — would make the table re-read a change that never happened.
    const onMailboxesChanged = vi.fn();
    mFetch.mockResolvedValue([account()]);
    render(
      <MemoryRouter initialEntries={["/inboxes"]}>
        <Routes>
          <Route
            path="/inboxes"
            element={
              <ConnectedMailboxes onMailboxesChanged={onMailboxesChanged} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("gmail-disconnect-acct_1"));
    expect(onMailboxesChanged).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("gmail-confirm-disconnect-acct_1"));
    await waitFor(() => expect(onMailboxesChanged).toHaveBeenCalledTimes(1));
  });

  it("does not claim a change when the disconnect failed", async () => {
    const onMailboxesChanged = vi.fn();
    mFetch.mockResolvedValue([account()]);
    mDisconnect.mockRejectedValue(new Error("API error: 500"));
    render(
      <MemoryRouter initialEntries={["/inboxes"]}>
        <Routes>
          <Route
            path="/inboxes"
            element={
              <ConnectedMailboxes onMailboxesChanged={onMailboxesChanged} />
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByTestId("gmail-disconnect-acct_1"));
    fireEvent.click(screen.getByTestId("gmail-confirm-disconnect-acct_1"));

    await waitFor(() => expect(mDisconnect).toHaveBeenCalledTimes(1));
    expect(onMailboxesChanged).not.toHaveBeenCalled();
    // And the row is still there, because nothing was disconnected.
    expect(screen.getByTestId("gmail-account-acct_1")).toBeTruthy();
  });

  it("says why, when the disconnect failed", async () => {
    // A row that sits there looking untouched reads as "the click didn't
    // register", and the operator clicks again. The server's own message is
    // the only thing that says otherwise, so it has to be on screen — this
    // pins the branch that renders it, which nothing else asserted.
    mFetch.mockResolvedValue([account()]);
    mDisconnect.mockRejectedValue(
      new Error("Gmail is still mapped to an inbox"),
    );
    renderAt();

    fireEvent.click(await screen.findByTestId("gmail-disconnect-acct_1"));
    fireEvent.click(screen.getByTestId("gmail-confirm-disconnect-acct_1"));

    // The server's sentence verbatim, not a generic "something went wrong".
    expect(
      await screen.findByText(/Gmail is still mapped to an inbox/),
    ).toBeTruthy();
  });

  it("explains what connecting does when no mailbox is connected", async () => {
    mFetch.mockResolvedValue([]);
    renderAt();

    const empty = await screen.findByTestId("gmail-empty-state");
    // Connecting does not backfill — say so, or it gets filed as a bug.
    expect(empty.textContent).toMatch(/backfill/i);
    expect(empty.textContent).toMatch(/going forward/i);
    expect(
      screen.getByRole("button", { name: /connect a google mailbox/i }),
    ).toBeTruthy();
  });

  it("shows an error, not an empty list, when loading the accounts fails", async () => {
    mFetch.mockRejectedValue(new Error("API error: 500"));
    renderAt();

    expect(await screen.findByTestId("gmail-load-error")).toBeTruthy();
    // Must not be mistaken for "you have no mailboxes connected".
    expect(screen.queryByTestId("gmail-empty-state")).toBeNull();
  });
});

/**
 * The OAuth callback redirects back to /inboxes?gmail=connected|error. Without
 * these, a failed connection returns the operator to an unchanged list and
 * tells them nothing, so they retry and get the same silence.
 */
describe("ConnectedMailboxes — OAuth round-trip result", () => {
  it("reports a failed connection when it lands on ?gmail=error", async () => {
    mFetch.mockResolvedValue([]);
    renderAt("/inboxes?gmail=error");

    const banner = await screen.findByTestId("gmail-connect-error");
    expect(banner.textContent).toMatch(/could ?n.t|did ?n.t|failed/i);
    // Tell them to try again, and where the reason actually is.
    expect(banner.textContent).toMatch(/try again/i);
    expect(banner.textContent).toMatch(/server log/i);
    // It is NOT the list-load error — different failure, different element.
    expect(screen.queryByTestId("gmail-load-error")).toBeNull();
  });

  it("confirms a successful connection on ?gmail=connected", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt("/inboxes?gmail=connected");

    const banner = await screen.findByTestId("gmail-connect-success");
    expect(banner.textContent).toMatch(/connected/i);
    // A success banner must never be shown for the failure branch.
    expect(screen.queryByTestId("gmail-connect-error")).toBeNull();
  });

  it("explains a callback refused because another admin started it", async () => {
    // The worker sends this when the signed state names a different admin
    // than the session finishing the flow. Without its own banner the
    // operator sees a generic failure and retries the identical thing.
    mFetch.mockResolvedValue([]);
    renderAt("/inboxes?gmail=wrong_admin");

    const banner = await screen.findByTestId("gmail-wrong-admin");
    expect(banner.textContent).toMatch(/different administrator/i);
    // Nothing was stored, and what to do instead.
    expect(banner.textContent).toMatch(/nothing was changed/i);
    expect(banner.textContent).toMatch(/start it again/i);
    // Not the generic failure, which would say something else entirely.
    expect(screen.queryByTestId("gmail-connect-error")).toBeNull();
    // And the param is cleared like every other outcome.
    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe(""),
    );
  });

  it("clears ?gmail=error from the URL so a refresh drops the banner", async () => {
    mFetch.mockResolvedValue([]);
    renderAt("/inboxes?gmail=error");

    await screen.findByTestId("gmail-connect-error");
    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe(""),
    );
    // Clearing the URL must not also clear the banner the operator is reading.
    expect(screen.getByTestId("gmail-connect-error")).toBeTruthy();
  });

  it("clears ?gmail=connected from the URL too", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt("/inboxes?gmail=connected");

    await screen.findByTestId("gmail-connect-success");
    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe(""),
    );
    expect(screen.getByTestId("gmail-connect-success")).toBeTruthy();
  });

  it("keeps other query params when clearing the gmail one", async () => {
    mFetch.mockResolvedValue([]);
    renderAt("/inboxes?gmail=error&q=ops");

    await screen.findByTestId("gmail-connect-error");
    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe("?q=ops"),
    );
  });

  it("shows neither banner on a plain visit", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt("/inboxes");

    await screen.findByTestId("gmail-account-acct_1");
    expect(screen.queryByTestId("gmail-connect-error")).toBeNull();
    expect(screen.queryByTestId("gmail-connect-success")).toBeNull();
  });

  it("shows neither banner for an unrecognised ?gmail= value", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt("/inboxes?gmail=wat");

    await screen.findByTestId("gmail-account-acct_1");
    expect(screen.queryByTestId("gmail-connect-error")).toBeNull();
    expect(screen.queryByTestId("gmail-connect-success")).toBeNull();
  });
});

/**
 * `/api/admin/gmail/connect` returns `{ authUrl }` with 200 — it does NOT
 * redirect. An anchor pointing at it lands the operator on a page of raw
 * JSON, which is exactly what shipped before this suite existed. jsdom
 * cannot follow a cross-origin navigation, so the navigation is stubbed and
 * asserted on rather than performed.
 */
describe("ConnectedMailboxes — starting the consent flow", () => {
  it("fetches the consent URL and navigates to it", async () => {
    mFetch.mockResolvedValue([]);
    renderAt();

    fireEvent.click(await screen.findByTestId("gmail-connect-button"));

    await waitFor(() => expect(mStartConnect).toHaveBeenCalledTimes(1));
    // The URL the server returned, not the API path we asked it for.
    await waitFor(() => expect(mNavigate).toHaveBeenCalledWith(CONSENT_URL));
    expect(mNavigate).toHaveBeenCalledTimes(1);
    expect(mNavigate).not.toHaveBeenCalledWith("/api/admin/gmail/connect");
  });

  it("shows the server's message and does not navigate when connect fails", async () => {
    mFetch.mockResolvedValue([]);
    // apiFetch surfaces the server's own { error }, so a 503 on an instance
    // with no OAuth secrets arrives as this exact sentence.
    mStartConnect.mockRejectedValue(
      new Error("Gmail integration is not configured"),
    );
    renderAt();

    fireEvent.click(await screen.findByTestId("gmail-connect-button"));

    const banner = await screen.findByTestId("gmail-connect-error");
    expect(banner.textContent).toContain("Gmail integration is not configured");
    // Navigating anyway would replace the message with a broken Google page.
    expect(mNavigate).not.toHaveBeenCalled();
  });

  it("does not fire two consent flows on a double-click", async () => {
    mFetch.mockResolvedValue([]);
    let release!: (v: { authUrl: string }) => void;
    mStartConnect.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderAt();

    const button = (await screen.findByTestId(
      "gmail-connect-button",
    )) as HTMLButtonElement;
    fireEvent.click(button);
    await waitFor(() => expect(button.disabled).toBe(true));

    fireEvent.click(button);
    fireEvent.click(button);
    expect(mStartConnect).toHaveBeenCalledTimes(1);

    release({ authUrl: CONSENT_URL });
    await waitFor(() => expect(mNavigate).toHaveBeenCalledWith(CONSENT_URL));
  });

  it("Reconnect starts a consent flow for an auth error", async () => {
    mFetch.mockResolvedValue([account({ lastError: "invalid_grant" })]);
    renderAt();

    fireEvent.click(await screen.findByTestId("gmail-reconnect-acct_1"));

    await waitFor(() => expect(mStartConnect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mNavigate).toHaveBeenCalledWith(CONSENT_URL));
  });

  it("offers Reconnect for an unrecognised Google auth code", async () => {
    // The auth codes come from Google's `error` field and that set is open
    // ended, so anything not known to be non-auth gets the affordance.
    mFetch.mockResolvedValue([account({ lastError: "invalid_client" })]);
    renderAt();

    expect(await screen.findByTestId("gmail-reconnect-acct_1")).toBeTruthy();
  });

  it.each([
    "no_personal_inbox",
    "ambiguous_inbox_mapping",
    "history_gap",
    "message_failed:18c2f0a1b2c3",
    // The sync engine records these when a whole run threw. A Gmail 5xx, a
    // rate limit or an unclassified throw is not a credential problem, and a
    // reconnect would re-seed the cursor — losing mail — to fix nothing.
    "sync_failed:http_500",
    "sync_failed:rate_limited",
    "sync_failed:unknown",
  ])(
    "does not offer Reconnect for %s — a new grant cannot fix it",
    async (lastError) => {
      mFetch.mockResolvedValue([account({ lastError })]);
      renderAt();

      const row = await screen.findByTestId("gmail-account-acct_1");
      expect(screen.queryByTestId("gmail-reconnect-acct_1")).toBeNull();
      // The error is still shown — hiding the action must not hide the problem.
      expect(row.textContent).toContain(lastError);
    },
  );

  /**
   * Hiding Reconnect is only half the fix: what replaces it is the operator's
   * only instruction, and each of these four codes needs a *different* one.
   * Without these, deleting `nonAuthGuidance` outright leaves the suite green.
   */
  it.each([
    ["no_personal_inbox", /map one below/i, /no inbox is mapped/i],
    ["ambiguous_inbox_mapping", /leave exactly one/i, /more than one inbox/i],
    ["history_gap", /re-seeded from the present/i, /next successful sync/i],
    ["message_failed:18c2f0a1b2c3", /the next run retries it/i, /cursor/i],
    [
      "sync_failed:http_500",
      /retries every 15 minutes/i,
      /last sync could not run/i,
    ],
  ])(
    "tells the operator what to do instead for %s",
    async (lastError, action, cause) => {
      mFetch.mockResolvedValue([account({ lastError })]);
      renderAt();

      const row = await screen.findByTestId("gmail-account-acct_1");
      expect(row.textContent).toMatch(action);
      expect(row.textContent).toMatch(cause);
      // And never the auth advice, which is the whole point of the branch.
      expect(row.textContent).not.toMatch(/until you reconnect it/i);
    },
  );

  /**
   * The one shape of `sync_failed:` a fresh grant DOES fix. A grant revoked
   * while the cached access token was still inside its TTL never reaches the
   * refresh path, so it surfaces as Gmail refusing the call — and Reconnect
   * is exactly the right offer for it.
   */
  it.each(["sync_failed:http_401", "sync_failed:http_403"])(
    "offers Reconnect for %s — Gmail refused the credential",
    async (lastError) => {
      mFetch.mockResolvedValue([account({ lastError })]);
      renderAt();

      const row = await screen.findByTestId("gmail-account-acct_1");
      expect(screen.getByTestId("gmail-reconnect-acct_1")).toBeTruthy();
      expect(row.textContent).toMatch(/until you reconnect it/i);
      expect(row.textContent).toContain(lastError);
    },
  );
});

/**
 * Reconnect is per-account, so the flow it starts must be per-account too.
 * A reconnect that does not name its mailbox grants whichever Google account
 * is signed in, and the callback upserts on the address it gets back — which
 * resets a *different*, healthy mailbox's sync cursor and loses its mail.
 */
describe("ConnectedMailboxes — a reconnect names its mailbox", () => {
  it("starts the consent flow for the account whose button was clicked", async () => {
    // Two accounts, and the second one's button: a single-account fixture
    // cannot tell "the right address" from "the first address".
    mFetch.mockResolvedValue([
      account({
        id: "acct_1",
        emailAddress: "first@example.com",
        lastError: "invalid_grant",
      }),
      account({
        id: "acct_2",
        emailAddress: "second@example.com",
        lastError: "invalid_grant",
      }),
    ]);
    renderAt();

    fireEvent.click(await screen.findByTestId("gmail-reconnect-acct_2"));

    await waitFor(() => expect(mStartConnect).toHaveBeenCalledTimes(1));
    expect(mStartConnect).toHaveBeenCalledWith("second@example.com");
    expect(mStartConnect).not.toHaveBeenCalledWith("first@example.com");
  });

  it("asks for no particular mailbox on a first connection", async () => {
    // Any account is a valid answer here, and pinning one would refuse the
    // mailbox the operator actually wants to add.
    mFetch.mockResolvedValue([]);
    renderAt();

    fireEvent.click(await screen.findByTestId("gmail-connect-button"));

    await waitFor(() => expect(mStartConnect).toHaveBeenCalledTimes(1));
    expect(mStartConnect).toHaveBeenCalledWith(undefined);
  });

  it("names both mailboxes when the callback refused a mis-aimed reconnect", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt(
      "/inboxes?gmail=wrong_account&gmail_expected=desk%40example.com&gmail_granted=jane%40example.com",
    );

    const banner = await screen.findByTestId("gmail-wrong-account");
    // Which one was meant, and which one was granted. Either alone leaves the
    // operator unable to tell what happened.
    expect(banner.textContent).toContain("desk@example.com");
    expect(banner.textContent).toContain("jane@example.com");
    // And it must not read as a success or a generic failure.
    expect(screen.queryByTestId("gmail-connect-success")).toBeNull();
    expect(screen.queryByTestId("gmail-connect-error")).toBeNull();
    // Nothing was written, and the operator needs to know that.
    expect(banner.textContent).toMatch(/nothing was changed/i);
  });

  it.each([
    ["no addresses at all", "/inboxes?gmail=wrong_account"],
    [
      "prose in place of an address",
      "/inboxes?gmail=wrong_account&gmail_expected=desk%40example.com&gmail_granted=Contact%20support%20at%20555-0100",
    ],
    [
      "one side missing",
      "/inboxes?gmail=wrong_account&gmail_granted=jane%40example.com",
    ],
    [
      "text that is not an address at all",
      "/inboxes?gmail=wrong_account&gmail_expected=desk%40example.com&gmail_granted=call-555-0100-immediately",
    ],
    [
      "something wearing two addresses",
      "/inboxes?gmail=wrong_account&gmail_expected=desk%40example.com&gmail_granted=jane%40example.com%40evil.test",
    ],
  ])(
    "does not read a hand-made URL back to the admin — %s",
    async (_case, path) => {
      // The banner is a red verdict from the server, and these values come
      // from the query string. Anything that is not an address means the URL
      // was made by hand, so the generic failure is shown instead of
      // whatever the link says — or a sentence with two blanks in it.
      mFetch.mockResolvedValue([account()]);
      renderAt(path);

      await screen.findByTestId("gmail-connect-error");
      expect(screen.queryByTestId("gmail-wrong-account")).toBeNull();
      expect(screen.getByTestId("gmail-connect-error").textContent).not.toMatch(
        /555-0100|evil.test/,
      );
    },
  );

  it("clears every gmail param after a refused reconnect", async () => {
    mFetch.mockResolvedValue([account()]);
    renderAt(
      "/inboxes?gmail=wrong_account&gmail_expected=desk%40example.com&gmail_granted=jane%40example.com&q=ops",
    );

    await screen.findByTestId("gmail-wrong-account");
    await waitFor(() =>
      expect(screen.getByTestId("location-search").textContent).toBe("?q=ops"),
    );
    expect(screen.getByTestId("gmail-wrong-account")).toBeTruthy();
  });
});
