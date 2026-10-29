import { useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Archive,
  Clock,
  FileText,
  Inbox,
  Info,
  ListOrdered,
  ListTodo,
  Send,
  SendHorizontal,
  Star,
  StickyNote,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import type { MailCategory, Stats } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  buildListSearch,
  CATEGORY_LABELS,
  FOLDER_LABELS,
  labelName,
  parseListState,
  type GmailFolder,
} from "./lib";
import { LabelDot } from "./ui";
import { dropOn, useRowDrag, DRAG_MIME, type DropTarget } from "./dnd";
import type { NavCounts } from "./state";

export function isInboxPath(pathname: string) {
  return pathname === "/" || pathname.startsWith("/inbox/");
}

const FOLDER_ICONS: Record<
  Exclude<GmailFolder, "all">,
  (p: { size: number }) => ReactNode
> = {
  inbox: (p) => <Inbox {...p} />,
  starred: (p) => <Star {...p} />,
  snoozed: (p) => <Clock {...p} />,
  sent: (p) => <SendHorizontal {...p} />,
  drafts: (p) => <StickyNote {...p} />,
  sequenced: (p) => <ListTodo {...p} />,
  archive: (p) => <Archive {...p} />,
  trash: (p) => <Trash2 {...p} />,
};

export const CATEGORY_ICONS: Record<
  MailCategory,
  (p: { size: number; className?: string }) => ReactNode
> = {
  primary: (p) => <Inbox {...p} />,
  promotions: (p) => <Tag {...p} />,
  social: (p) => <Users {...p} />,
  updates: (p) => <Info {...p} />,
};

const FOLDER_ORDER: Array<Exclude<GmailFolder, "all">> = [
  "inbox",
  "starred",
  "snoozed",
  "sent",
  "drafts",
  "sequenced",
  "archive",
  "trash",
];

const DROPPABLE: Partial<Record<GmailFolder, DropTarget>> = {
  inbox: "inbox",
  starred: "starred",
  snoozed: "snoozed",
  archive: "archive",
  trash: "trash",
};

export interface LabelEntry {
  address: string;
  displayName: string | null;
}

export function labelsFrom(stats: Stats | null): LabelEntry[] {
  if (!stats) return [];
  const seen = new Set<string>();
  const out: LabelEntry[] = [];
  for (const s of stats.senderIdentities ?? []) {
    const k = s.email.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ address: s.email, displayName: s.displayName });
  }
  for (const r of stats.recipients ?? []) {
    const k = r.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ address: r, displayName: null });
  }
  return out.sort((a, b) =>
    labelName(a.address, a.displayName).localeCompare(
      labelName(b.address, b.displayName),
    ),
  );
}

function NavRow({
  icon,
  label,
  active,
  count,
  bold,
  onClick,
  testId,
  drop,
  title,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  count?: number;
  bold?: boolean;
  onClick: () => void;
  testId?: string;
  /** Accept dragged rows. */
  drop?: DropTarget;
  title?: string;
}) {
  const [over, setOver] = useState(false);
  return (
    <button
      type="button"
      className={cn("gm-nav-item w-[calc(100%-16px)] text-left")}
      data-active={active ? "true" : undefined}
      data-drop-over={over ? "true" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      title={title ?? label}
      data-testid={testId}
      onDragOver={
        drop
          ? (e) => {
              if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(true);
            }
          : undefined
      }
      onDragLeave={drop ? () => setOver(false) : undefined}
      onDrop={
        drop
          ? (e) => {
              e.preventDefault();
              setOver(false);
              dropOn(drop);
            }
          : undefined
      }
    >
      {icon}
      <span
        className="gm-nav-text min-w-0 flex-1 truncate"
        style={bold && !active ? { fontWeight: 700 } : undefined}
      >
        {label}
      </span>
      {count !== undefined && count > 0 && (
        <span
          className="gm-nav-count text-xs"
          style={{ fontWeight: bold || active ? 700 : 400 }}
        >
          {count.toLocaleString()}
        </span>
      )}
    </button>
  );
}

/**
 * Gmail's folder + label list. Used by the desktop sidebar (full or rail)
 * and the mobile drawer. Folder state lives in the URL. Rows can be
 * dragged onto Inbox, Starred, Snoozed, Archive and (while dragging) Trash.
 */
export function GmailNavList({
  stats,
  counts,
  tabsOn,
  showCategories,
  onNavigate,
  extra,
}: {
  stats: Stats | null;
  counts: NavCounts;
  tabsOn: boolean;
  /** List the inbox tabs as their own entries (the mobile drawer). */
  showCategories?: boolean;
  /** Called after any navigation (closes the mobile drawer). */
  onNavigate?: () => void;
  extra?: ReactNode;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const dragging = useRowDrag();
  const onInbox = isInboxPath(location.pathname);
  const state = parseListState(new URLSearchParams(location.search));
  const labels = labelsFrom(stats);
  const plain = !state.label && !state.q && !state.from && !state.unread;

  const go = (to: string) => {
    navigate(to);
    onNavigate?.();
  };

  const folderCount = (f: GmailFolder): { count?: number; bold?: boolean } => {
    if (f === "inbox")
      return { count: counts.inboxUnread, bold: counts.inboxUnread > 0 };
    if (f === "drafts") return { count: counts.drafts };
    return {};
  };

  return (
    <nav aria-label="Mail folders" className="flex flex-col pb-4">
      {FOLDER_ORDER.map((f) => {
        const Icon = FOLDER_ICONS[f];
        const active =
          onInbox &&
          plain &&
          state.folder === f &&
          !(
            showCategories &&
            f === "inbox" &&
            state.tab &&
            state.tab !== "primary"
          );
        const c = folderCount(f);
        return (
          <div key={f}>
            <NavRow
              icon={<Icon size={20} />}
              label={
                showCategories && f === "inbox" && tabsOn
                  ? "Primary"
                  : FOLDER_LABELS[f]
              }
              active={active}
              count={c.count}
              bold={c.bold}
              onClick={() => go(`/${buildListSearch({ folder: f })}`)}
              testId={`gmail-nav-${f}`}
              drop={DROPPABLE[f]}
              title={
                DROPPABLE[f] && dragging
                  ? `Move ${dragging} to ${FOLDER_LABELS[f]}`
                  : undefined
              }
            />
            {showCategories &&
              f === "inbox" &&
              tabsOn &&
              (["promotions", "social", "updates"] as MailCategory[]).map(
                (c) => {
                  const CI = CATEGORY_ICONS[c];
                  const n = counts.categories[c] ?? 0;
                  return (
                    <NavRow
                      key={c}
                      icon={<CI size={20} />}
                      label={CATEGORY_LABELS[c]}
                      active={
                        onInbox &&
                        plain &&
                        state.folder === "inbox" &&
                        state.tab === c
                      }
                      count={n}
                      bold={false}
                      onClick={() =>
                        go(`/${buildListSearch({ folder: "inbox", tab: c })}`)
                      }
                      testId={`gmail-nav-cat-${c}`}
                    />
                  );
                },
              )}
          </div>
        );
      })}
      <NavRow
        icon={<Send size={20} />}
        label="Outbox"
        active={location.pathname === "/outbox"}
        count={counts.outbox}
        onClick={() => go("/outbox")}
      />

      {labels.length > 0 && (
        <>
          <div className="gm-nav-heading mt-4 flex h-10 items-center pl-[26px] text-base font-medium text-text-primary">
            Labels
          </div>
          {labels.map((l) => {
            const unread = stats?.inboxUnread?.[l.address] ?? 0;
            return (
              <NavRow
                key={l.address}
                icon={<LabelDot address={l.address} />}
                label={labelName(l.address, l.displayName)}
                title={`${l.address}${unread ? ` · ${unread} unread` : ""}`}
                active={onInbox && state.label === l.address}
                count={unread}
                bold={unread > 0}
                onClick={() =>
                  go(`/${buildListSearch({ folder: "all", label: l.address })}`)
                }
                testId={`gmail-label-${l.address}`}
              />
            );
          })}
        </>
      )}

      <div className="gm-nav-heading mt-4 h-px" />
      <NavRow
        icon={<FileText size={20} />}
        label="Templates"
        active={location.pathname.startsWith("/templates")}
        onClick={() => go("/templates")}
      />
      <NavRow
        icon={<ListOrdered size={20} />}
        label="Sequences"
        active={location.pathname.startsWith("/sequences")}
        onClick={() => go("/sequences")}
      />
      {extra}
    </nav>
  );
}

export { NavRow };
