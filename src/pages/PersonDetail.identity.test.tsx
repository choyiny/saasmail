import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AgentContextProvider } from "@/agent/AgentContext";

const api = vi.hoisted(() => ({
  fetchPersonEmails: vi.fn(),
  markEmailRead: vi.fn(),
  markPeopleRead: vi.fn(),
  deleteEmail: vi.fn(),
  fetchPersonEnrollment: vi.fn(),
  fetchStats: vi.fn(),
  addBlock: vi.fn(),
  fetchCustomerByPerson: vi.fn(),
  fetchPeople: vi.fn(),
  linkCustomerPeople: vi.fn(),
  unlinkCustomerPerson: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/EnrollSequenceModal", () => ({ default: () => null }));
vi.mock("@/components/PersonListMemberships", () => ({ default: () => null }));
vi.mock("@/components/ReassignPersonModal", () => ({ default: () => null }));
vi.mock("@/components/SequenceStatus", () => ({ default: () => null }));
vi.mock("@/components/EmailHtmlModal", () => ({ default: () => null }));
vi.mock("@/components/ReplyComposer", () => ({ default: () => null }));
vi.mock("@/components/SuggestedReplyCard", () => ({ default: () => null }));
vi.mock("@/components/ThreadInboxSection", () => ({ default: () => null }));
vi.mock("@/components/ChatInboxSection", () => ({ default: () => null }));
vi.mock("@/components/MarkAllReadButton", () => ({ default: () => null }));

import PersonDetail from "@/pages/PersonDetail";

const linkedCustomer = {
  id: "customer-1",
  displayName: null,
  people: [
    { id: "person-1", email: "one@example.com", name: "One" },
    { id: "person-2", email: "two@example.com", name: "Two" },
  ],
};

const person = {
  type: "person" as const,
  id: "person-1",
  email: "one@example.com",
  name: "One",
  lastEmailAt: 100,
  unreadCount: 0,
  totalCount: 0,
  recipientCount: 0,
  recipients: [],
  hasAttachment: 0,
  linkedCount: 1,
};

function renderDetail() {
  return render(
    <MemoryRouter>
      <AgentContextProvider>
        <PersonDetail
          person={person}
          onEmailRead={() => {}}
          onEmailDelete={() => {}}
        />
      </AgentContextProvider>
    </MemoryRouter>,
  );
}

describe("PersonDetail identity graph", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchCustomerByPerson.mockResolvedValue({ customer: linkedCustomer });
    api.fetchPersonEmails.mockResolvedValue({ emails: [], inboxes: [] });
    api.fetchPersonEnrollment.mockResolvedValue({ enrollment: null });
    api.fetchStats.mockResolvedValue({ senderIdentities: [] });
    api.fetchPeople.mockResolvedValue({
      data: [
        {
          id: "person-3",
          email: "three@example.com",
          name: "Three",
          recipient: "support@example.com",
          lastEmailAt: 1,
          unreadCount: 0,
          totalCount: 1,
        },
      ],
      total: 1,
      page: 1,
      limit: 20,
    });
    api.linkCustomerPeople.mockResolvedValue({
      ...linkedCustomer,
      people: [
        ...linkedCustomer.people,
        { id: "person-3", email: "three@example.com", name: "Three" },
      ],
    });
    api.unlinkCustomerPerson.mockResolvedValue({ success: true });
  });

  it("shows linked chips and defaults the customer timeline to all addresses", async () => {
    renderDetail();

    const row = await screen.findByTestId("linked-addresses");
    expect(row.textContent).toContain("one@example.com");
    expect(row.textContent).toContain("two@example.com");
    expect(
      (screen.getByTestId("all-addresses-toggle") as HTMLInputElement).checked,
    ).toBe(true);
    await waitFor(() =>
      expect(api.fetchPersonEmails).toHaveBeenCalledWith("person-1", {
        allAddresses: true,
      }),
    );
  });

  it("opens people search, links and unlinks chips, and toggles timeline scope", async () => {
    renderDetail();
    await screen.findByTestId("linked-addresses");

    fireEvent.click(screen.getByTestId("link-address-button"));
    expect(await screen.findByTestId("link-address-picker")).toBeTruthy();
    const search = screen.getByLabelText("Search people to link");
    fireEvent.change(search, { target: { value: "three" } });
    const candidate = await screen.findByTestId("link-candidate-person-3");
    fireEvent.click(candidate);
    await waitFor(() =>
      expect(api.linkCustomerPeople).toHaveBeenCalledWith(
        "person-1",
        "person-3",
      ),
    );

    fireEvent.click(screen.getByTestId("unlink-address-person-2"));
    await waitFor(() =>
      expect(api.unlinkCustomerPerson).toHaveBeenCalledWith("person-2"),
    );

    const toggle = screen.getByTestId(
      "all-addresses-toggle",
    ) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(api.fetchPersonEmails).toHaveBeenLastCalledWith("person-1", {
        allAddresses: false,
      }),
    );
  });
});
