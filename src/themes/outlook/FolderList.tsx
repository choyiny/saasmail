import { useState } from "react";
import {
  Archive,
  ChevronRight,
  Clock,
  FileEdit,
  Inbox as InboxIcon,
  ListOrdered,
  Mail,
  MailCheck,
  MailOpen,
  Send,
  SendHorizontal,
  Star,
  StarOff,
  Trash2,
} from "lucide-react";
import type { Stats } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  FOLDER_LABELS,
  favoriteKey,
  parseFavorite,
  type OlFolderId,
} from "./lib";
import { MenuItem, MenuSeparator, PointMenu } from "./Menu";
import { FlagGlyph } from "./ui";
import { useOutlook } from "./context";

export interface FolderTarget {
  folder: OlFolderId;
  label?: string;
}

/** Folders rows can be dropped on, and what dropping does. */
export type DropTarget =
  | "inbox"
  | "archive"
  | "deleted"
  | "snoozed"
  | "flagged";
const DROPPABLE: Partial<Record<OlFolderId, DropTarget>> = {
  inbox: "inbox",
  archive: "archive",
  deleted: "deleted",
  snoozed: "snoozed",
  flagged: "flagged",
};
export const ROW_DRAG_TYPE = "application/x-saasmail-rows";

const FOLDER_ICONS: Record<OlFolderId, React.ReactNode> = {
  inbox: <InboxIcon size={18} />,
  drafts: <FileEdit size={18} />,
  sent: <Send size={18} />,
  archive: <Archive size={18} />,
  snoozed: <Clock size={18} />,
  flagged: <FlagGlyph size={18} />,
  sequenced: <ListOrdered size={18} />,
  unread: <MailOpen size={18} />,
  deleted: <Trash2 size={18} />,
};

/** URL for a folder (folder and inbox live in the query string). */
export function folderHref(t: FolderTarget): string {
  const p = new URLSearchParams();
  if (t.folder !== "inbox") p.set("folder", t.folder);
  if (t.label) p.set("label", t.label);
  const s = p.toString();
  return s ? `/?${s}` : "/";
}

export interface FolderListProps {
  stats: Stats | null;
  accountEmail: string;
  current: FolderTarget;
  onSelect: (t: FolderTarget) => void;
  onOutbox: () => void;
  favorites: string[];
  favoritesOpen: boolean;
  onFavoritesOpen: (open: boolean) => void;
  onToggleFavorite: (key: string) => void;
  onMarkAllRead: (t: FolderTarget) => void;
  /** Permanently delete everything in Deleted Items. */
  onEmptyTrash?: () => void;
  /** Rows dropped on a folder (desktop drag and drop). */
  onDropRows?: (dest: DropTarget) => void;
  /** Touch layout (mobile drawer): bigger rows, no drag. */
  touch?: boolean;
}

function Row({
  icon,
  label,
  count,
  active,
  onClick,
  title,
  accentCount,
  onContextMenu,
  drop,
  onDropRows,
  favorite,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
  title?: string;
  accentCount?: boolean;
  onContextMenu?: (e: React.MouseEvent | React.KeyboardEvent) => void;
  drop?: DropTarget;
  onDropRows?: (dest: DropTarget) => void;
  favorite?: boolean;
}) {
  const [over, setOver] = useState(false);
  const canDrop = !!drop && !!onDropRows;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-current={active ? "page" : undefined}
      className={cn(
        "ol-folder",
        active && "ol-folder-on",
        over && "ol-folder-drop",
      )}
      data-folder={label}
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(e);
      }}
      onKeyDown={(e) => {
        if (
          onContextMenu &&
          (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10"))
        ) {
          e.preventDefault();
          onContextMenu(e);
        }
      }}
      onDragOver={
        canDrop
          ? (e) => {
              if (!e.dataTransfer.types.includes(ROW_DRAG_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              setOver(true);
            }
          : undefined
      }
      onDragLeave={canDrop ? () => setOver(false) : undefined}
      onDrop={
        canDrop
          ? (e) => {
              e.preventDefault();
              setOver(false);
              onDropRows!(drop!);
            }
          : undefined
      }
    >
      <span className="ol-folder-icon" aria-hidden>
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      {favorite && (
        <Star
          size={12}
          className="ol-folder-fav-star"
          aria-label="In Favorites"
        />
      )}
      {!!count && (
        <span className={cn("ol-folder-count", accentCount && "text-accent")}>
          {count}
        </span>
      )}
    </button>
  );
}

function Section({
  title,
  icon,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="ol-folder-section">
      <button
        type="button"
        className="ol-folder-heading"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      >
        <ChevronRight
          size={16}
          aria-hidden
          className={cn("ol-chev", open && "ol-chev-open")}
        />
        {icon}
        <span className="truncate">{title}</span>
      </button>
      {open && <div className="flex flex-col">{children}</div>}
    </div>
  );
}

/**
 * Outlook's folder pane: Favorites (customisable, starred), the account's
 * folders, then one folder per inbox address (filters with `recipient`).
 * Right-click a folder for Mark all as read and Add/Remove Favorites; drop
 * rows on Inbox, Archive, Deleted Items, Snoozed or Flagged to move them.
 */
export default function FolderList(props: FolderListProps) {
  const {
    stats,
    accountEmail,
    current,
    onSelect,
    onOutbox,
    favorites,
    favoritesOpen,
    onFavoritesOpen,
    onToggleFavorite,
    onMarkAllRead,
    onDropRows,
    onEmptyTrash,
  } = props;
  const o = useOutlook();
  const accountOpen = o.accountOpen;
  const inboxesOpen = o.inboxesOpen;
  const setAccountOpen = (v: boolean) => o.setLayout({ accountOpen: v });
  const setInboxesOpen = (v: boolean) => o.setLayout({ inboxesOpen: v });
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    target: FolderTarget;
    name: string;
  } | null>(null);

  const unread = stats?.unreadCount ?? 0;
  const inboxUnread = stats?.inboxUnread ?? {};
  const identities = new Map(
    (stats?.senderIdentities ?? []).map((s) => [s.email, s.displayName]),
  );
  const is = (t: FolderTarget) =>
    current.folder === t.folder && (current.label ?? "") === (t.label ?? "");
  const nameOf = (t: FolderTarget) =>
    t.label ? identities.get(t.label) || t.label : FOLDER_LABELS[t.folder];
  const countOf = (t: FolderTarget): number | undefined => {
    if (t.label) return inboxUnread[t.label];
    if (t.folder === "inbox" || t.folder === "unread") return unread;
    return undefined;
  };
  const iconOf = (t: FolderTarget) =>
    t.label ? <Mail size={18} /> : FOLDER_ICONS[t.folder];

  const openMenu = (
    e: React.MouseEvent | React.KeyboardEvent,
    target: FolderTarget,
  ) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const me = e as React.MouseEvent;
    const x = me.clientX ? me.clientX : r.left + 24;
    const y = me.clientY ? me.clientY : r.bottom;
    setMenu({ x, y, target, name: nameOf(target) });
  };

  const row = (t: FolderTarget, inFavorites = false) => {
    const key = favoriteKey(t.folder, t.label);
    return (
      <Row
        key={(inFavorites ? "fav:" : "") + key}
        icon={iconOf(t)}
        label={nameOf(t)}
        title={t.label ?? nameOf(t)}
        count={countOf(t)}
        accentCount
        active={
          is(t) && (inFavorites || !favorites.includes(key) || !favoritesOpen)
        }
        onClick={() => onSelect(t)}
        onContextMenu={(e) => openMenu(e, t)}
        drop={t.label ? undefined : DROPPABLE[t.folder]}
        onDropRows={props.touch ? undefined : onDropRows}
        favorite={!inFavorites && favorites.includes(key)}
      />
    );
  };

  const favTargets = favorites
    .map(parseFavorite)
    .filter((x): x is FolderTarget => !!x);
  const accountFolders: OlFolderId[] = [
    "inbox",
    "drafts",
    "sent",
    "archive",
    "snoozed",
    "flagged",
    "sequenced",
    "deleted",
  ];

  const menuKey = menu
    ? favoriteKey(menu.target.folder, menu.target.label)
    : "";
  const inFav = favorites.includes(menuKey);

  return (
    <nav
      aria-label="Folders"
      className={cn(
        "flex flex-col gap-1 pb-4",
        props.touch && "ol-folders-touch",
      )}
    >
      <Section
        title="Favorites"
        icon={<Star size={13} className="text-text-secondary" aria-hidden />}
        open={favoritesOpen}
        onOpenChange={onFavoritesOpen}
      >
        {favTargets.map((t) => row(t, true))}
        {favTargets.length === 0 && (
          <p className="px-6 py-2 text-[12px] text-text-secondary">
            Right-click a folder and choose Add to Favorites.
          </p>
        )}
      </Section>
      <Section
        title={accountEmail || "Mailbox"}
        open={accountOpen}
        onOpenChange={setAccountOpen}
      >
        {accountFolders.map((f) => row({ folder: f }))}
        <Row
          icon={<SendHorizontal size={18} />}
          label="Outbox"
          active={false}
          onClick={onOutbox}
        />
      </Section>
      {(stats?.recipients.length ?? 0) > 0 && (
        <Section
          title="Inboxes"
          open={inboxesOpen}
          onOpenChange={setInboxesOpen}
        >
          {stats!.recipients.map((r) => row({ folder: "inbox", label: r }))}
        </Section>
      )}

      <PointMenu
        point={menu ? { x: menu.x, y: menu.y } : null}
        onClose={() => setMenu(null)}
        label={menu ? `${menu.name} options` : undefined}
      >
        {menu && (
          <>
            <MenuItem
              icon={<Mail size={16} />}
              onSelect={() => onSelect(menu.target)}
            >
              Open
            </MenuItem>
            {!["deleted", "sent", "drafts"].includes(menu.target.folder) && (
              <MenuItem
                icon={<MailCheck size={16} />}
                onSelect={() => onMarkAllRead(menu.target)}
              >
                Mark all as read
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuItem
              icon={inFav ? <StarOff size={16} /> : <Star size={16} />}
              onSelect={() => onToggleFavorite(menuKey)}
            >
              {inFav ? "Remove from Favorites" : "Add to Favorites"}
            </MenuItem>
            {menu.target.folder === "deleted" && onEmptyTrash && (
              <>
                <MenuSeparator />
                <MenuItem
                  icon={<Trash2 size={16} />}
                  danger
                  onSelect={onEmptyTrash}
                >
                  Empty folder
                </MenuItem>
              </>
            )}
          </>
        )}
      </PointMenu>
    </nav>
  );
}
