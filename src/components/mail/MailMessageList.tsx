import type { ReactNode, RefObject } from "react";
import { ArrowLeft, MailOpen, Paperclip, Search, Star } from "lucide-react";
import type { MailMessage } from "@/lib/api";
import type { SystemFolder } from "@/hooks/useMailMessages";

function counterparty(message: MailMessage): string {
  if (message.direction === "inbound") {
    return message.from?.name || message.from?.email || "Unknown sender";
  }
  return message.to.name || message.to.email;
}

function bodySnippet(message: MailMessage): string {
  const text = (message.bodyText ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}

function compactTime(timestamp: number): string {
  const date = new Date(timestamp * 1000);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function unixSeconds(date: Date): number {
  return Math.floor(date.getTime() / 1000);
}

function snoozedLabel(timestamp: number): string {
  return `Snoozed until ${new Date(timestamp * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })}`;
}

interface MailMessageRowProps {
  message: MailMessage;
  selected: boolean;
  active: boolean;
  checked: boolean;
  busy: boolean;
  onSelect: (ref: string) => void;
  onToggleSelected: (ref: string) => void;
  onToggleStar: (message: MailMessage) => void;
}

export function MailMessageRow({
  message,
  selected,
  active,
  checked,
  busy,
  onSelect,
  onToggleSelected,
  onToggleStar,
}: MailMessageRowProps) {
  const unseen = message.direction === "inbound" && !message.state.seen;
  const snippet = bodySnippet(message);

  return (
    <div
      role="button"
      tabIndex={0}
      data-testid="mail-message-row"
      data-message-ref={message.ref}
      onClick={() => onSelect(message.ref)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect(message.ref);
        }
      }}
      className={`border-b border-border px-3 py-3 text-left transition-colors hover:bg-bg-subtle ${
        selected
          ? "bg-bg-muted"
          : active
            ? "bg-bg-subtle ring-1 ring-inset ring-border"
            : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="Select message"
          checked={checked}
          onChange={() => onToggleSelected(message.ref)}
          onClick={(event) => event.stopPropagation()}
          className="h-3.5 w-3.5 shrink-0 rounded border-border"
        />
        <span
          className={`min-w-0 flex-1 truncate text-xs text-text-primary ${
            unseen ? "font-bold" : "font-medium"
          }`}
        >
          {counterparty(message)}
        </span>
        {message.attachmentCount ? (
          <Paperclip className="h-3 w-3 shrink-0 text-text-tertiary" />
        ) : null}
        <button
          type="button"
          disabled={busy}
          aria-label={message.state.starredAt ? "Remove star" : "Add star"}
          onClick={(event) => {
            event.stopPropagation();
            onToggleStar(message);
          }}
          className="rounded p-0.5 text-text-tertiary hover:bg-bg-muted hover:text-text-primary disabled:opacity-50"
        >
          <Star
            className={`h-3.5 w-3.5 ${
              message.state.starredAt ? "fill-current" : ""
            }`}
          />
        </button>
        <span className="shrink-0 text-[10px] text-text-tertiary">
          {compactTime(message.occurredAt)}
        </span>
      </div>
      <p
        className={`mt-1 truncate text-sm text-text-primary ${
          unseen ? "font-semibold" : "font-normal"
        }`}
      >
        {message.subject || "(no subject)"}
      </p>
      {snippet && (
        <p className="mt-1 line-clamp-2 text-xs leading-4 text-text-tertiary">
          {snippet}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {message.source.campaignId && (
          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-secondary">
            Campaign
          </span>
        )}
        {message.source.sequenceId && (
          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-text-secondary">
            Sequence
          </span>
        )}
        {message.state.snoozedUntil &&
          message.state.snoozedUntil > unixSeconds(new Date()) && (
            <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[9px] text-text-secondary">
              {snoozedLabel(message.state.snoozedUntil)}
            </span>
          )}
      </div>
    </div>
  );
}

interface MailMessageListProps {
  visible: boolean;
  currentFolderLabel: string;
  systemFolder?: SystemFolder;
  query: string;
  showCampaignSends: boolean;
  onShowCampaignSendsChange: (value: boolean) => void;
  showNewMessages: boolean;
  listScrollRef: RefObject<HTMLDivElement | null>;
  loading: boolean;
  loadingMore: boolean;
  messages: MailMessage[];
  nextCursor: string | null;
  selectedRef: string | null;
  activeRef: string | null;
  actionBusyRef: string | null;
  selectedRefs: ReadonlySet<string>;
  selectionBar?: ReactNode;
  onBackToFolders: () => void;
  onSearch: (value: string) => void;
  onReachedTop: () => void;
  onRefreshNewMessages: () => void;
  onSelectMessage: (ref: string) => void;
  onToggleSelected: (ref: string) => void;
  onToggleSelectAll: () => void;
  onToggleStar: (message: MailMessage) => void;
  onLoadMore: (cursor: string) => void;
}

export default function MailMessageList({
  visible,
  currentFolderLabel,
  systemFolder,
  query,
  showCampaignSends,
  onShowCampaignSendsChange,
  showNewMessages,
  listScrollRef,
  loading,
  loadingMore,
  messages,
  nextCursor,
  selectedRef,
  activeRef,
  actionBusyRef,
  selectedRefs,
  selectionBar,
  onBackToFolders,
  onSearch,
  onReachedTop,
  onRefreshNewMessages,
  onSelectMessage,
  onToggleSelected,
  onToggleSelectAll,
  onToggleStar,
  onLoadMore,
}: MailMessageListProps) {
  return (
    <section
      className={`${visible ? "flex" : "hidden"} w-full min-w-0 flex-col border-r border-border md:flex md:w-[390px] md:shrink-0`}
    >
      <div className="border-b border-border p-3">
        <div className="mb-2 flex items-center gap-2">
          <input
            type="checkbox"
            aria-label="Select all loaded messages"
            checked={
              messages.length > 0 &&
              messages.every((message) => selectedRefs.has(message.ref))
            }
            onChange={onToggleSelectAll}
            disabled={messages.length === 0}
            className="h-3.5 w-3.5 shrink-0 rounded border-border"
          />
          <button
            type="button"
            onClick={onBackToFolders}
            className="inline-flex items-center gap-1 rounded-[6px] px-2 py-1 text-xs text-text-secondary hover:bg-bg-muted md:hidden"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Folders
          </button>
          <h1 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
            {currentFolderLabel}
          </h1>
          {systemFolder === "sent" && (
            <label className="flex shrink-0 items-center gap-1.5 text-[10px] text-text-secondary">
              <input
                type="checkbox"
                checked={showCampaignSends}
                onChange={(event) =>
                  onShowCampaignSendsChange(event.target.checked)
                }
                className="h-3 w-3 rounded border-border"
              />
              Show campaign sends
            </label>
          )}
        </div>
        <label className="relative block">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-tertiary" />
          <input
            aria-label="Search mail"
            value={query}
            onChange={(event) => onSearch(event.target.value)}
            placeholder="Search this folder"
            className="w-full rounded-[6px] border border-border bg-bg-subtle py-2 pl-8 pr-3 text-xs text-text-primary outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
        </label>
      </div>

      {selectionBar}

      {showNewMessages && (
        <div className="border-b border-border bg-bg-subtle p-2">
          <button
            type="button"
            data-testid="mail-new-messages"
            onClick={onRefreshNewMessages}
            className="w-full rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-background"
          >
            New messages
          </button>
        </div>
      )}

      <div
        ref={listScrollRef}
        onScroll={(event) => {
          if (event.currentTarget.scrollTop <= 4) onReachedTop();
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {loading ? (
          <p className="p-4 text-sm text-text-tertiary">Loading messages…</p>
        ) : messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
            <MailOpen className="h-6 w-6 text-text-tertiary" />
            <p className="text-sm text-text-tertiary">No messages here.</p>
          </div>
        ) : (
          <>
            {messages.map((message) => (
              <MailMessageRow
                key={message.ref}
                message={message}
                selected={selectedRef === message.ref}
                active={activeRef === message.ref}
                checked={selectedRefs.has(message.ref)}
                busy={actionBusyRef === message.ref}
                onSelect={onSelectMessage}
                onToggleSelected={onToggleSelected}
                onToggleStar={onToggleStar}
              />
            ))}
            {nextCursor && (
              <div className="p-3">
                <button
                  type="button"
                  disabled={loadingMore}
                  data-testid="mail-load-more"
                  onClick={() => onLoadMore(nextCursor)}
                  className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-subtle hover:text-text-primary disabled:opacity-50"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
