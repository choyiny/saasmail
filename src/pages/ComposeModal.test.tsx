import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  deleteDraft: vi.fn(),
  fetchDraft: vi.fn(),
  fetchStats: vi.fn(),
  saveDraft: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("@/lib/api", () => api);
vi.mock("@/components/TiptapEditor", () => ({
  default: () => <div data-testid="tiptap-mock" />,
}));

import ComposeModal from "@/pages/ComposeModal";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("ComposeModal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.saveDraft.mockResolvedValue(undefined);
    api.deleteDraft.mockResolvedValue(undefined);
  });

  it("keeps a resumed draft's sender when the inbox list arrives after it", async () => {
    const stats = deferred<unknown>();
    api.fetchStats.mockReturnValue(stats.promise);
    api.fetchDraft.mockResolvedValue({
      contextKey: "draft:resume",
      fromAddress: "support@example.test",
      toAddress: "resume@customers.test",
      cc: null,
      subject: "Resume me",
      bodyHtml: "<p>Resume me</p>",
      bodyText: "Resume me",
    });

    render(<ComposeModal open onClose={() => {}} contextKey="draft:resume" />);

    await waitFor(() =>
      expect(screen.getByDisplayValue("Resume me")).toBeTruthy(),
    );

    stats.resolve({
      recipients: ["marketing@example.test", "support@example.test"],
      senderIdentities: [],
    });

    const from = await screen.findByRole("combobox");
    await waitFor(() =>
      expect((from as HTMLSelectElement).value).toBe("support@example.test"),
    );
  });

  it("falls back to the first inbox when nothing set a sender", async () => {
    api.fetchStats.mockResolvedValue({
      recipients: ["marketing@example.test", "support@example.test"],
      senderIdentities: [],
    });
    api.fetchDraft.mockResolvedValue(null);

    render(<ComposeModal open onClose={() => {}} contextKey="draft:new" />);

    const from = await screen.findByRole("combobox");
    await waitFor(() =>
      expect((from as HTMLSelectElement).value).toBe("marketing@example.test"),
    );
  });
});
