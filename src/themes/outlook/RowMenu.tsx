import {
  Inbox,
  Undo2,
  Archive,
  Ban,
  Clock,
  ExternalLink,
  FolderInput,
  Forward,
  Inbox as InboxIcon,
  Mail,
  MailOpen,
  Pin,
  PinOff,
  Reply,
  ReplyAll,
  Search,
  Trash2,
  Brush,
} from "lucide-react";
import type { GroupedItem } from "@/lib/api";
import { itemKey } from "@/hooks/useMailList";
import { flagReminder } from "./lib";
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
} from "./Menu";
import { SnoozeMenuItems } from "./Snooze";
import {
  queueConversationCommand,
  sendConversationCommand,
  type ConversationCommand,
} from "./Conversation";
import type { OutlookMail } from "./useOutlookMail";
import { useMailUi } from "./actions";
import { FlagGlyph } from "./ui";

/** Open a conversation on its own (Outlook's "Open in new window"). */
export function openInNewWindow(item: GroupedItem) {
  window.open(
    `/?open=${encodeURIComponent(itemKey(item))}&popout=1`,
    "_blank",
    "popup,width=980,height=820",
  );
}

/**
 * Right-click menu for message list rows (and the "⋯" on mobile rows),
 * matching Outlook's: reply actions, delete/archive/move, flag with a
 * reminder, pin, read state, snooze, block, find related, new window.
 */
export default function RowMenu({
  items,
  mail,
}: {
  items: GroupedItem[];
  mail: OutlookMail;
}) {
  const ui = useMailUi();
  const single = items.length === 1 ? items[0] : null;
  const anyUnread = items.some((i) => i.unreadCount > 0);
  const allFlagged = items.every((i) => i.starred);
  const allPinned = items.every((i) => i.pinned);
  const person = single?.type === "person" ? single : null;
  // Sender overrides (Focused / Other) only apply to person rows.
  const anyPerson = items.some((i) => i.type === "person");
  const inTrash = mail.folder === "deleted";

  const replyCmd = (cmd: ConversationCommand) => {
    if (!single) return;
    if (mail.openKey === itemKey(single)) sendConversationCommand(cmd);
    else {
      queueConversationCommand(itemKey(single), cmd);
      mail.openItem(single);
    }
  };
  const flagAt = (when: Parameters<typeof flagReminder>[0]) =>
    mail.ops.flag(items, true, flagReminder(when));

  return (
    <>
      {single && (
        <>
          <MenuItem
            icon={<Reply size={16} />}
            onSelect={() => replyCmd("reply")}
            shortcut="Ctrl+R"
          >
            Reply
          </MenuItem>
          <MenuItem
            icon={<ReplyAll size={16} />}
            onSelect={() => replyCmd("replyAll")}
          >
            Reply all
          </MenuItem>
          <MenuItem
            icon={<Forward size={16} />}
            onSelect={() => replyCmd("forward")}
          >
            Forward
          </MenuItem>
          <MenuSeparator />
        </>
      )}
      {inTrash ? (
        <>
          <MenuItem
            icon={<Undo2 size={16} />}
            onSelect={() => mail.ops.restore(items)}
          >
            Restore
          </MenuItem>
          {anyPerson && mail.canDeleteForever && (
            <MenuItem
              icon={<Trash2 size={16} />}
              danger
              onSelect={() => void mail.ops.deleteForever(items)}
              shortcut="Del"
            >
              Delete forever
            </MenuItem>
          )}
        </>
      ) : (
        <>
          <MenuItem
            icon={<Trash2 size={16} />}
            onSelect={() => mail.ops.delete(items)}
            shortcut="Del"
          >
            Delete
          </MenuItem>
          <MenuItem
            icon={<Archive size={16} />}
            onSelect={() => mail.ops.archive(items)}
            shortcut="E"
          >
            Archive
          </MenuItem>
        </>
      )}
      <MenuSub>
        <MenuSubTrigger icon={<FolderInput size={16} />}>Move</MenuSubTrigger>
        <MenuSubContent>
          <MenuItem
            icon={<InboxIcon size={16} />}
            onSelect={() => mail.ops.moveToInbox(items)}
          >
            Inbox
          </MenuItem>
          <MenuItem
            icon={<Archive size={16} />}
            onSelect={() => mail.ops.archive(items)}
          >
            Archive
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<FolderInput size={16} />}
            onSelect={() => ui.requestMove(items)}
            shortcut="Ctrl+Shift+V"
          >
            Other folder…
          </MenuItem>
        </MenuSubContent>
      </MenuSub>
      <MenuSeparator />
      <MenuSub>
        <MenuSubTrigger icon={<FlagGlyph size={16} filled={allFlagged} />}>
          Flag
        </MenuSubTrigger>
        <MenuSubContent>
          <MenuItem onSelect={() => flagAt("tomorrow")} shortcut="remind 8 AM">
            Tomorrow
          </MenuItem>
          <MenuItem onSelect={() => flagAt("thisweek")}>This week</MenuItem>
          <MenuItem onSelect={() => flagAt("nextweek")}>Next week</MenuItem>
          <MenuItem onSelect={() => mail.ops.flag(items, true)}>
            No date
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<FlagGlyph size={16} />}
            onSelect={() => mail.ops.flag(items, !allFlagged)}
            shortcut="Insert"
          >
            {allFlagged ? "Clear flag" : "Flag"}
          </MenuItem>
        </MenuSubContent>
      </MenuSub>
      <MenuItem
        icon={allPinned ? <PinOff size={16} /> : <Pin size={16} />}
        onSelect={() => mail.ops.pin(items, !allPinned)}
      >
        {allPinned ? "Unpin" : "Pin"}
      </MenuItem>
      <MenuItem
        icon={anyUnread ? <MailOpen size={16} /> : <Mail size={16} />}
        onSelect={() => mail.ops.toggleRead(items)}
        shortcut={anyUnread ? "Q" : "U"}
      >
        {anyUnread ? "Mark as read" : "Mark as unread"}
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger icon={<Clock size={16} />}>Snooze</MenuSubTrigger>
        <MenuSubContent>
          <SnoozeMenuItems
            onPick={(u) => mail.ops.snooze(items, u)}
            onCustom={() => ui.requestSnooze(items)}
          />
        </MenuSubContent>
      </MenuSub>
      <MenuSeparator />
      {person && (
        <MenuItem
          icon={<Ban size={16} />}
          onSelect={() => void mail.ops.block(person)}
        >
          Block sender
        </MenuItem>
      )}
      {anyPerson && (
        <>
          <MenuItem
            icon={<Inbox size={16} />}
            onSelect={() => void mail.ops.setFocus(items, "focused")}
          >
            Always move to Focused
          </MenuItem>
          <MenuItem
            icon={<Inbox size={16} />}
            onSelect={() => void mail.ops.setFocus(items, "other")}
          >
            Always move to Other
          </MenuItem>
        </>
      )}
      <MenuItem
        icon={<Brush size={16} />}
        onSelect={() => ui.requestSweep(items)}
      >
        Sweep…
      </MenuItem>
      {(person || single?.latestSubject) && (
        <MenuSub>
          <MenuSubTrigger icon={<Search size={16} />}>
            Find related
          </MenuSubTrigger>
          <MenuSubContent>
            {person && (
              <MenuItem
                onSelect={() => mail.setQuery(`from:${person.email}`, "all")}
              >
                Messages from sender
              </MenuItem>
            )}
            {single?.latestSubject && (
              <MenuItem
                onSelect={() =>
                  mail.setQuery(
                    `subject:"${single.latestSubject!.replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, "").replace(/"/g, "")}"`,
                    "all",
                  )
                }
              >
                Messages in this conversation
              </MenuItem>
            )}
          </MenuSubContent>
        </MenuSub>
      )}
      {single && (
        <>
          <MenuSeparator />
          <MenuItem
            icon={<ExternalLink size={16} />}
            onSelect={() => openInNewWindow(single)}
          >
            Open in new window
          </MenuItem>
        </>
      )}
    </>
  );
}
