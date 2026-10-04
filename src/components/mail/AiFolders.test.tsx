// docs/specs/SPEC-ai-folders.md: folder chips and "File with AI".
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MailMessageRow } from "@/components/mail/MailMessageList";
import MailSelectionBar from "@/components/mail/MailSelectionBar";
import type { Mailbox } from "@/lib/api";

function folder(
  id: string,
  name: string,
  color: Mailbox["color"] = null,
): Mailbox {
  return {
    id,
    inbox: "support@example.com",
    name,
    role: null,
    parentId: null,
    sortOrder: 0,
    color,
    aiDescription: null,
    createdBy: null,
    createdAt: 1,
    updatedAt: 1,
    ruleCount: 0,
  };
}

const message = (mailboxIds: string[]) =>
  ({
    ref: "received:e1",
    direction: "inbound",
    inbox: "support@example.com",
    personId: "p1",
    conversationId: null,
    messageId: null,
    inReplyTo: null,
    from: { email: "alice@example.com", name: "Alice" },
    to: { email: "support@example.com" },
    cc: [],
    subject: "Invoice",
    bodyText: "hello",
    bodyHtml: null,
    occurredAt: 1_800_000_000,
    isRead: false,
    source: { campaignId: null, sequenceId: null, sequenceEnrollmentId: null },
    delivery: null,
    state: {
      seen: false,
      starredAt: null,
      archivedAt: null,
      spamAt: null,
      trashedAt: null,
      mailboxIds,
      conversationKey: null,
      snoozedUntil: null,
      assignedUserId: null,
    },
  }) as any;

function row(mailboxIds: string[], folders: Mailbox[]) {
  return render(
    <MailMessageRow
      message={message(mailboxIds)}
      selected={false}
      active={false}
      checked={false}
      busy={false}
      folders={folders}
      onSelect={() => {}}
      onToggleSelected={() => {}}
      onToggleStar={() => {}}
    />,
  );
}

describe("folder chips", () => {
  it("names up to three of the message's folders, in colour, then +N", () => {
    const folders = [
      folder("a", "Billing", "teal"),
      folder("b", "Bugs"),
      folder("c", "Leads", "pink"),
      folder("d", "Legal"),
      folder("e", "Other"),
    ];
    row(["a", "b", "c", "d", "x"], folders);
    const chips = screen.getAllByTestId("mail-folder-chip");
    expect(chips.map((chip) => chip.textContent)).toEqual([
      "Billing",
      "Bugs",
      "Leads",
    ]);
    expect(chips[0].className).toContain("text-teal-700");
    expect(screen.getByText("+1").getAttribute("title")).toBe("Legal");
  });

  it("shows none for a message in no custom folder", () => {
    row([], [folder("a", "Billing")]);
    expect(screen.queryByTestId("mail-folder-chip")).toBeNull();
  });
});

describe("File with AI in the selection bar", () => {
  const bar = (aiFile: { unavailable: string | null; onFile: () => void }) =>
    render(
      <MailSelectionBar
        count={2}
        busy={false}
        canArchiveSpam
        markSeen
        star
        archive
        spam
        trash
        mailboxes={[]}
        onSeen={() => {}}
        onStar={() => {}}
        onArchive={() => {}}
        onSpam={() => {}}
        onTrash={() => {}}
        onSnooze={() => {}}
        onMove={() => {}}
        onAssign={() => {}}
        onClear={() => {}}
        aiFile={aiFile}
      />,
    );

  it("files the selection", () => {
    const onFile = vi.fn();
    bar({ unavailable: null, onFile });
    fireEvent.click(screen.getByTestId("mail-bulk-ai-file"));
    expect(onFile).toHaveBeenCalled();
  });

  it("is disabled and says why without a model or a described folder", () => {
    bar({
      unavailable: "Describe what belongs in a folder first (edit a folder)",
      onFile: () => {},
    });
    const button = screen.getByTestId("mail-bulk-ai-file") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(
      "Describe what belongs in a folder first (edit a folder)",
    );
  });
});
