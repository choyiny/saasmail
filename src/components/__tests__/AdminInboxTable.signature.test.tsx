import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
  type AdminInbox,
} from "@/lib/api";

vi.mock("@/lib/api", () => ({
  fetchAdminInboxes: vi.fn(),
  fetchAdminUsers: vi.fn(),
  fetchGmailAccounts: vi.fn(),
  fetchOutlookAccounts: vi.fn(() => Promise.resolve([])),
  updateInboxSettings: vi.fn(),
  updateInboxAssignments: vi.fn(),
  createInbox: vi.fn(),
  deleteInbox: vi.fn(),
}));

// Tiptap is slow to boot in jsdom; the stub surfaces the props the editor
// was handed so the tests can see what it would show and whether it focuses.
vi.mock("@/components/TiptapEditor", () => ({
  default: ({
    content,
    autoFocus,
  }: {
    content: string;
    autoFocus?: boolean;
  }) => (
    <div
      data-testid="tiptap-stub"
      data-content={content}
      data-autofocus={String(!!autoFocus)}
    />
  ),
}));

const BILLING = "billing@acme.dev";
const SUPPORT = "support@acme.dev";

const inbox = (over: Partial<AdminInbox> & { email: string }): AdminInbox => ({
  displayName: null,
  displayMode: "chat",
  signatureHtml: null,
  forwardTo: null,
  assignedUserIds: [],
  source: "cloudflare",
  gmailAccountId: null,
  outlookAccountId: null,
  ...over,
});

async function editButtonFor(email: string): Promise<HTMLElement> {
  const row = await waitFor(() => {
    const el = document.querySelector<HTMLElement>(
      `[data-testid="inbox-row"][data-inbox-email="${email}"]`,
    );
    if (!el) throw new Error(`no row for ${email}`);
    return el;
  });
  return within(row).getByTestId("inbox-signature-edit-button");
}

// jsdom has no layout, so scrollIntoView isn't implemented; install a spy.
const scrollIntoView = vi.fn();
const originalScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  scrollIntoView.mockReset();
  Element.prototype.scrollIntoView = scrollIntoView;
  vi.mocked(fetchAdminUsers).mockReset().mockResolvedValue([]);
  vi.mocked(fetchGmailAccounts).mockReset().mockResolvedValue([]);
  vi.mocked(fetchAdminInboxes)
    .mockReset()
    .mockResolvedValue([
      inbox({ email: BILLING, signatureHtml: "<p>Billing team</p>" }),
      inbox({ email: SUPPORT, signatureHtml: "<p>Support team</p>" }),
    ]);
});

afterEach(() => {
  Element.prototype.scrollIntoView = originalScrollIntoView;
});

describe("AdminInboxTable — signature editor", () => {
  it("scrolls the editor into view and focuses it when Edit is clicked", async () => {
    render(<AdminInboxTable />);

    fireEvent.click(await editButtonFor(SUPPORT));

    const editor = await screen.findByTestId("inbox-signature-editor");
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(editor);
    expect(
      within(editor).getByTestId("tiptap-stub").getAttribute("data-autofocus"),
    ).toBe("true");
  });

  it("shows the newly picked inbox's signature when switching rows", async () => {
    render(<AdminInboxTable />);

    fireEvent.click(await editButtonFor(BILLING));
    const first = await screen.findByTestId("tiptap-stub");
    expect(first.getAttribute("data-content")).toBe("<p>Billing team</p>");

    fireEvent.click(await editButtonFor(SUPPORT));

    const editor = await screen.findByTestId("inbox-signature-editor");
    expect(within(editor).getByText(SUPPORT)).toBeTruthy();
    expect(
      within(editor).getByTestId("tiptap-stub").getAttribute("data-content"),
    ).toBe("<p>Support team</p>");
    // Re-opening on another row scrolls again.
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
