import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ArchiveRestore,
  CalendarClock,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderInput,
  Forward,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Pin,
  Reply,
  ReplyAll,
  Search,
  Star,
  Tags,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import type { GroupedItem } from "@/lib/api";
import { snoozePresets } from "@/hooks/useMailList";
import { itemTitle } from "@/hooks/useMailList";
import { canMoveToTab, inInboxView, type RowActions } from "./actions";
import { CATEGORIES, CATEGORY_LABELS } from "./lib";

export interface RowMenuState {
  x: number;
  y: number;
  /** The rows the menu acts on (the right-clicked row, or the selection). */
  items: GroupedItem[];
}

function Item({
  icon,
  children,
  onSelect,
  disabled,
  hint,
}: {
  icon: ReactNode;
  children: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <Menu.Item className="gm-menu-item" onSelect={onSelect} disabled={disabled}>
      {icon}
      <span className="flex-1">{children}</span>
      {hint && (
        <kbd aria-hidden className="text-xs text-text-tertiary">
          {hint}
        </kbd>
      )}
    </Menu.Item>
  );
}

function Sub({
  icon,
  label,
  children,
  disabled,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Menu.Sub>
      <Menu.SubTrigger className="gm-menu-item" disabled={disabled}>
        {icon}
        <span className="flex-1">{label}</span>
        <ChevronRight size={16} />
      </Menu.SubTrigger>
      <Menu.Portal>
        <Menu.SubContent
          className="gm-menu"
          sideOffset={2}
          collisionPadding={8}
        >
          {children}
        </Menu.SubContent>
      </Menu.Portal>
    </Menu.Sub>
  );
}

const sep = <Menu.Separator className="gm-menu-sep" />;

/**
 * Gmail's right-click menu for list rows, anchored at the pointer. Also
 * opened by the `.` / `v` shortcuts at the focused row.
 */
export function RowMenu({
  state,
  onClose,
  act,
}: {
  state: RowMenuState | null;
  onClose: () => void;
  act: RowActions;
}) {
  const items = state?.items ?? [];
  const one = items.length === 1 ? items[0] : null;
  const anyUnread = items.some((i) => i.unreadCount > 0);
  const allStarred = items.length > 0 && items.every((i) => i.starred);
  const allPinned = items.length > 0 && items.every((i) => i.pinned);
  const outOfInbox = items.some((i) => !inInboxView(i));
  const anyTrashed = items.some((i) => !!i.trashedAt);
  const canDelete = !anyTrashed || items.some((i) => i.type === "person");
  // In Trash, Delete means delete forever: admins only.
  const showDelete = !anyTrashed || act.canDeleteForever;
  const canMoveTab = canMoveToTab(items);
  const run = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Menu.Root
      open={!!state}
      onOpenChange={(o) => !o && onClose()}
      modal={false}
    >
      <Menu.Trigger asChild>
        <span
          aria-hidden
          style={{
            position: "fixed",
            left: state?.x ?? 0,
            top: state?.y ?? 0,
            width: 1,
            height: 1,
            pointerEvents: "none",
          }}
        />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          className="gm-menu min-w-[260px]"
          align="start"
          side="bottom"
          sideOffset={2}
          collisionPadding={8}
          data-testid="gmail-row-menu"
          aria-label={
            one
              ? `Actions for ${itemTitle(one)}`
              : `Actions for ${items.length} conversations`
          }
        >
          <Item
            icon={<Reply size={18} />}
            onSelect={run(() => one && act.respond(one, "reply"))}
            disabled={!one}
            hint="r"
          >
            Reply
          </Item>
          <Item
            icon={<ReplyAll size={18} />}
            onSelect={run(() => one && act.respond(one, "replyAll"))}
            disabled={!one}
            hint="a"
          >
            Reply all
          </Item>
          <Item
            icon={<Forward size={18} />}
            onSelect={run(() => one && act.respond(one, "forward"))}
            disabled={!one}
            hint="f"
          >
            Forward
          </Item>
          {sep}
          {anyTrashed ? (
            <Item
              icon={<ArchiveRestore size={18} />}
              onSelect={run(() => act.restore(items))}
            >
              Restore from Trash
            </Item>
          ) : outOfInbox ? (
            <Item
              icon={<InboxIcon size={18} />}
              onSelect={run(() => act.moveToInbox(items))}
            >
              Move to inbox
            </Item>
          ) : (
            <Item
              icon={<Archive size={18} />}
              onSelect={run(() => act.archive(items))}
              hint="e"
            >
              Archive
            </Item>
          )}
          {showDelete && (
            <Item
              icon={<Trash2 size={18} />}
              onSelect={run(() => act.requestDelete(items))}
              disabled={!canDelete}
              hint={anyTrashed ? undefined : "#"}
            >
              {anyTrashed ? "Delete forever" : "Delete"}
            </Item>
          )}
          {anyUnread ? (
            <Item
              icon={<MailOpen size={18} />}
              onSelect={run(() => act.markRead(items))}
              hint="⇧I"
            >
              Mark as read
            </Item>
          ) : (
            <Item
              icon={<Mail size={18} />}
              onSelect={run(() => void act.markUnread(items))}
              hint="⇧U"
            >
              Mark as unread
            </Item>
          )}
          <Sub icon={<Clock size={18} />} label="Snooze">
            {snoozePresets().map((p) => (
              <Menu.Item
                key={p.id}
                className="gm-menu-item"
                onSelect={run(() => act.snooze(items, p.until))}
              >
                <span className="flex-1">{p.label}</span>
                <span className="text-xs text-text-secondary">
                  {new Date(p.until * 1000).toLocaleString(undefined, {
                    weekday: "short",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </span>
              </Menu.Item>
            ))}
            <Menu.Separator className="gm-menu-sep" />
            <Menu.Item
              className="gm-menu-item"
              onSelect={run(() => act.pickSnooze(items))}
            >
              <CalendarClock size={18} />
              <span>Pick date & time</span>
            </Menu.Item>
          </Sub>
          {sep}
          <Item
            icon={
              <Star
                size={18}
                className={allStarred ? "fill-current text-star" : undefined}
              />
            }
            onSelect={run(() => act.star(items, !allStarred))}
            hint="s"
          >
            {allStarred ? "Remove star" : "Add star"}
          </Item>
          <Item
            icon={<Pin size={18} />}
            onSelect={run(() => act.pin(items, !allPinned))}
          >
            {allPinned ? "Unpin" : "Pin to top"}
          </Item>
          <Sub icon={<FolderInput size={18} />} label="Move to">
            <Menu.Item
              className="gm-menu-item"
              onSelect={run(() => act.moveToInbox(items))}
            >
              <InboxIcon size={18} /> Inbox
            </Menu.Item>
            <Menu.Item
              className="gm-menu-item"
              onSelect={run(() => act.archive(items))}
            >
              <Archive size={18} /> Archive
            </Menu.Item>
            <Menu.Item
              className="gm-menu-item"
              onSelect={run(() => act.pickSnooze(items))}
            >
              <Clock size={18} /> Snoozed…
            </Menu.Item>
            <Menu.Item
              className="gm-menu-item"
              onSelect={run(() => act.star(items, true))}
            >
              <Star size={18} /> Starred
            </Menu.Item>
          </Sub>
          {canMoveTab && (
            <Sub icon={<Tags size={18} />} label="Move to tab">
              <Menu.Label className="max-w-[260px] px-4 pb-2 pt-1 text-xs text-text-secondary">
                Future mail from {one ? "this sender" : "these senders"} goes to
                the tab you pick.
                {items.some((i) => i.type !== "person") &&
                  " Group conversations can't change tabs."}
              </Menu.Label>
              {CATEGORIES.map((c) => (
                <Menu.Item
                  key={c}
                  className="gm-menu-item"
                  onSelect={run(() => act.moveToCategory(items, c))}
                >
                  {CATEGORY_LABELS[c]}
                  {one?.category === c && (
                    <span className="ml-auto text-xs text-text-secondary">
                      current
                    </span>
                  )}
                </Menu.Item>
              ))}
            </Sub>
          )}
          {sep}
          <Item
            icon={<Search size={18} />}
            onSelect={run(() => one && act.findFrom(one))}
            disabled={!one}
          >
            {one
              ? `Find emails from ${one.type === "person" ? one.name || one.email : itemTitle(one)}`
              : "Find emails from sender"}
          </Item>
          <Item
            icon={<ExternalLink size={18} />}
            onSelect={run(() => one && act.openInNewWindow(one))}
            disabled={!one}
          >
            Open in new window
          </Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
