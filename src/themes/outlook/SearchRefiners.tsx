import { useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  Folder,
  Mail,
  Paperclip,
  User,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  FOLDER_LABELS,
  buildSearchQuery,
  type OlFolderId,
  type ParsedQuery,
} from "./lib";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "./Menu";
import type { OutlookMail } from "./useOutlookMail";
import { FlagGlyph } from "./ui";

const DAY = 86400;

/**
 * Outlook's search refiners, shown under the search box while searching:
 * From, To, Has attachments, Date, Folder, Unread, Flagged. Each one edits
 * the query text (from:, hasattachments:yes, received>=, folder:, …) so the
 * search box and the refiners stay in sync.
 */
export default function SearchRefiners({ mail }: { mail: OutlookMail }) {
  const p = mail.parsed;
  const [fromDraft, setFromDraft] = useState(p.from ?? "");
  const set = (patch: Partial<ParsedQuery>) =>
    mail.setQuery(buildSearchQuery({ ...p, ...patch }));
  const identities = mail.list.stats?.senderIdentities ?? [];
  const now = Math.floor(Date.now() / 1000);
  // Typed dates are UTC days (received>=2026-01-01); show them that way.
  const fmt = (t: number) =>
    new Date(t * 1000).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  const dateLabel =
    p.after !== undefined && p.before !== undefined
      ? p.before - p.after === DAY
        ? `On ${fmt(p.after)}`
        : `${fmt(p.after)} – ${fmt(p.before - DAY)}`
      : p.after !== undefined
        ? `Since ${fmt(p.after)}`
        : p.before !== undefined
          ? `Until ${fmt(p.before - DAY)}`
          : "Date";
  const active = (on: boolean) => cn("ol-refiner", on && "ol-refiner-on");

  return (
    <div className="ol-refiners" role="toolbar" aria-label="Search refiners">
      <span className="text-[13px] text-text-secondary">
        Results for{" "}
        <span className="font-semibold text-text-primary">
          {[p.text, mail.toAsText].filter(Boolean).join(" ") || "everything"}
        </span>
      </span>
      <Menu onOpenChange={(o) => o && setFromDraft(p.from ?? "")}>
        <MenuTrigger asChild>
          <button type="button" className={active(!!p.from)}>
            <User size={14} aria-hidden />
            {p.from ? `From: ${p.from}` : "From"}
            <ChevronDown size={12} aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start" className="w-[280px] p-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              set({ from: fromDraft.trim() || undefined });
            }}
            className="flex gap-2"
          >
            <input
              autoFocus
              value={fromDraft}
              onChange={(e) => setFromDraft(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder="Name or address"
              aria-label="From"
              className="ol-text-input min-w-0 flex-1"
            />
            <button type="submit" className="ol-btn-primary">
              Apply
            </button>
          </form>
          {p.from && (
            <MenuItem onSelect={() => set({ from: undefined })}>
              Clear From
            </MenuItem>
          )}
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={active(!!p.to)}
            title={
              mail.toAsText
                ? `${mail.toAsText} isn't one of your inboxes, so it's searched as text`
                : undefined
            }
          >
            <Mail size={14} aria-hidden />
            {p.to ? `To: ${p.to}${mail.toAsText ? " (text)" : ""}` : "To"}
            <ChevronDown size={12} aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuRadioGroup
            value={p.to ?? ""}
            onValueChange={(v) => set({ to: v || undefined })}
          >
            <MenuRadioItem value="">Any inbox</MenuRadioItem>
            {identities.map((s) => (
              <MenuRadioItem key={s.email} value={s.email}>
                {s.displayName ? `${s.displayName} <${s.email}>` : s.email}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <button
        type="button"
        className={active(p.hasAttachment === true)}
        aria-pressed={p.hasAttachment === true}
        onClick={() =>
          set({ hasAttachment: p.hasAttachment ? undefined : true })
        }
      >
        <Paperclip size={14} aria-hidden /> Has attachments
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            className={active(p.after !== undefined || p.before !== undefined)}
          >
            <CalendarDays size={14} aria-hidden />
            {dateLabel}
            <ChevronDown size={12} aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuItem
            onSelect={() => set({ after: undefined, before: undefined })}
          >
            Any time
          </MenuItem>
          <MenuItem
            onSelect={() => set({ after: now - DAY, before: undefined })}
          >
            Last 24 hours
          </MenuItem>
          <MenuItem
            onSelect={() => set({ after: now - 7 * DAY, before: undefined })}
          >
            Last 7 days
          </MenuItem>
          <MenuItem
            onSelect={() => set({ after: now - 30 * DAY, before: undefined })}
          >
            Last 30 days
          </MenuItem>
          <MenuItem
            onSelect={() => set({ after: now - 365 * DAY, before: undefined })}
          >
            Last year
          </MenuItem>
        </MenuContent>
      </Menu>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" className={active(!!p.folder)}>
            <Folder size={14} aria-hidden />
            {p.folder ? FOLDER_LABELS[p.folder] : "All folders"}
            <ChevronDown size={12} aria-hidden />
          </button>
        </MenuTrigger>
        <MenuContent align="start">
          <MenuRadioGroup
            value={p.folder ?? ""}
            onValueChange={(v) =>
              set({ folder: (v || undefined) as OlFolderId | undefined })
            }
          >
            <MenuRadioItem value="">All folders</MenuRadioItem>
            {(
              [
                "inbox",
                "sent",
                "drafts",
                "archive",
                "snoozed",
                "flagged",
                "unread",
                "deleted",
              ] as OlFolderId[]
            ).map((f) => (
              <MenuRadioItem key={f} value={f}>
                {FOLDER_LABELS[f]}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuContent>
      </Menu>
      <button
        type="button"
        className={active(p.unread === true)}
        aria-pressed={p.unread === true}
        onClick={() => set({ unread: p.unread ? undefined : true })}
      >
        Unread
      </button>
      <button
        type="button"
        className={active(p.flagged === true)}
        aria-pressed={p.flagged === true}
        onClick={() => set({ flagged: p.flagged ? undefined : true })}
      >
        <FlagGlyph size={14} /> Flagged
      </button>
      <button
        type="button"
        className="ol-refiner ol-refiner-clear"
        onClick={() => mail.setQuery("")}
      >
        <X size={14} aria-hidden /> Exit search
      </button>
    </div>
  );
}
