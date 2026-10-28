import {
  Archive,
  Clock,
  Inbox,
  ListTodo,
  Search,
  SendHorizontal,
  Star,
  StickyNote,
  Tag,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { negatedOperators, type ListState } from "./lib";

/** Calm, Gmail-style empty states per folder. */
export function EmptyState({
  state,
  onCompose,
}: {
  state: ListState;
  onCompose: () => void;
}) {
  let icon: ReactNode = <Inbox size={40} />;
  let title = "Your inbox is empty";
  let body: ReactNode = "New mail sent to any of your inboxes shows up here.";

  if (state.q || state.from || state.attachment) {
    icon = <Search size={40} />;
    title = "No messages matched your search";
    const negated = state.q ? negatedOperators(state.q) : [];
    body =
      negated.length > 0
        ? `Search can't exclude mail, so ${negated.join(", ")} was searched as plain text. Remove the "-" to search for it, or use search options to narrow by sender, inbox or unread mail.`
        : "Try different words, or use search options to look by sender, inbox or unread mail.";
  } else if (state.folder === "inbox" && state.tab && state.tab !== "primary") {
    icon = <Tag size={40} />;
    title = `Your ${state.tab[0].toUpperCase()}${state.tab.slice(1)} tab is empty`;
    body = {
      promotions: "Deals, offers and other marketing mail will show up here.",
      social:
        "Messages from social networks and media-sharing sites will show up here.",
      updates:
        "Receipts, confirmations, bills and other automated notifications will show up here.",
    }[state.tab];
  } else if (state.label) {
    icon = <Tag size={40} />;
    title = "There are no conversations with this label";
    body = `Mail sent to ${state.label} will appear here.`;
  } else if (state.unread) {
    title = "No unread mail";
    body = "You're all caught up.";
  } else {
    switch (state.folder) {
      case "starred":
        icon = <Star size={40} />;
        title = "No starred messages";
        body =
          "Stars let you give conversations a special status to make them easier to find. To star one, click the star outline beside any conversation.";
        break;
      case "snoozed":
        icon = <Clock size={40} />;
        title = "Nothing snoozed";
        body =
          "Snoozed conversations leave your inbox and come back to the top at the time you choose.";
        break;
      case "sent":
        icon = <SendHorizontal size={40} />;
        title = "No sent messages";
        body = (
          <>
            <button
              type="button"
              onClick={onCompose}
              className="font-medium text-accent hover:underline"
            >
              Send one now
            </button>
          </>
        );
        break;
      case "drafts":
        icon = <StickyNote size={40} />;
        title = "You don't have any saved drafts";
        body =
          "Saving a draft lets you keep a reply you aren't ready to send yet.";
        break;
      case "sequenced":
        icon = <ListTodo size={40} />;
        title = "No sequenced conversations";
        body =
          "People enrolled in a sequence show up here while their follow-ups are scheduled.";
        break;
      case "trash":
        icon = <Trash2 size={40} />;
        title = "No conversations in Trash";
        body =
          "Deleted conversations wait here until you empty Trash or delete them forever. New mail brings a conversation back.";
        break;
      case "archive":
        icon = <Archive size={40} />;
        title = "Nothing archived";
        body =
          "Archived conversations stay out of your inbox until someone replies.";
        break;
      case "all":
        title = "No conversations";
        body = "";
        break;
    }
  }

  return (
    <div
      className="flex flex-col items-center px-8 py-16 text-center"
      data-testid="gmail-empty"
    >
      <span className="mb-4 text-text-tertiary">{icon}</span>
      <p className="text-base text-text-primary">{title}</p>
      {body && (
        <p className="mt-2 max-w-[440px] text-sm leading-relaxed text-text-secondary">
          {body}
        </p>
      )}
    </div>
  );
}
