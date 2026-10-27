import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { GroupedItem } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { usePreferences } from "@/lib/preferences";
import { cn } from "@/lib/utils";
import { useMedia, useOutlook } from "./context";
import FolderList, { type DropTarget } from "./FolderList";
import MessageList from "./MessageList";
import ReadingPane from "./ReadingPane";
import Ribbon from "./Ribbon";
import SearchRefiners from "./SearchRefiners";
import { commandForKey, isTypingTarget } from "./lib";
import {
  queueConversationCommand,
  sendConversationCommand,
} from "./Conversation";
import { useMailUi } from "./actions";
import type { OutlookMail } from "./useOutlookMail";
import { itemKey } from "@/hooks/useMailList";

/** Panes F6 cycles through, in Outlook's order. */
const PANE_SELECTORS = [
  ".ol-ribbon [role=tab][aria-selected=true]",
  ".ol-folder-pane .ol-folder-on, .ol-folder-pane .ol-folder",
  ".ol-list-scroll [tabindex='0'], .ol-list-scroll",
  ".ol-reading-scroll, .ol-reading",
];

/** Outlook on the web keyboard shortcuts for the mail module. */
function useShortcuts(mail: OutlookMail) {
  const o = useOutlook();
  const ui = useMailUi();
  const ref = useRef({ mail, o, ui });
  ref.current = { mail, o, ui };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { mail, o, ui } = ref.current;
      if (e.defaultPrevented || e.isComposing) return;
      const cmd = commandForKey(e);
      if (!cmd) return;
      const typing = isTypingTarget(e.target);
      // Ctrl+N works from fields; everything else waits until you leave it.
      if (typing && !(cmd === "newMail" && (e.ctrlKey || e.metaKey))) return;
      if (
        document.querySelector(
          "[role=dialog][data-state=open], [role=menu][data-state=open], [role=alertdialog]",
        )
      )
        return;
      // Single-letter keys only act in the mail list / reading pane, not on
      // buttons in the header where a user might be typing a shortcut.
      const t = mail.targets;
      const run = (fn: () => void) => {
        e.preventDefault();
        fn();
      };
      const conv = (c: "reply" | "replyAll" | "forward") => {
        if (!t[0] || t.length !== 1) return;
        run(() => {
          if (mail.openKey === itemKey(t[0])) sendConversationCommand(c);
          else {
            queueConversationCommand(itemKey(t[0]), c);
            mail.openItem(t[0]);
          }
        });
      };
      switch (cmd) {
        case "newMail":
          return run(() => o.openCompose(null));
        case "reply":
        case "replyAll":
        case "forward":
          return conv(cmd);
        case "delete":
          // Delete → Deleted Items; Shift+Delete deletes permanently
          // (asks) for admins. Others can't purge, so it's a plain Delete.
          if (t.length)
            run(() =>
              e.shiftKey && mail.canDeleteForever
                ? void mail.ops.deleteForever(t)
                : void mail.ops.delete(t),
            );
          return;
        case "archive":
          if (t.length) run(() => mail.ops.archive(t));
          return;
        case "move":
          if (t.length) run(() => ui.requestMove(t));
          return;
        case "flag":
          if (t.length) run(() => mail.ops.flag(t));
          return;
        case "markRead":
          if (t.length) run(() => mail.ops.markRead(t));
          return;
        case "markUnread":
          if (t.length) run(() => void mail.ops.markUnread(t));
          return;
        case "undo":
          return run(() => void mail.undo());
        case "next":
          return run(() => mail.stepTo(1));
        case "prev":
          return run(() => mail.stepTo(-1));
        case "first":
          return run(() => mail.stepTo("first"));
        case "last":
          return run(() => mail.stepTo("last"));
        case "open": {
          const el = document.activeElement as HTMLElement | null;
          const key = el?.dataset?.key;
          const it = key ? mail.allItems.find((i) => itemKey(i) === key) : null;
          if (it) run(() => mail.openItem(it));
          return;
        }
        case "close":
          if (o.settingsOpen) return run(() => o.setSettingsOpen(false));
          if (o.compose) return run(() => o.closeCompose());
          if (mail.openKey || mail.selected.size)
            return run(() => mail.clearSelection());
          return;
        case "help":
          return run(() => o.setShortcutsOpen(true));
        case "search":
          return run(() => window.dispatchEvent(new Event("ol:focus-search")));
        case "selectAll":
          return run(() => mail.selectAll());
        case "ribbon":
          return run(() =>
            document
              .querySelector<HTMLElement>("[data-ribbon-tab=home]")
              ?.focus(),
          );
        case "panes":
          return run(() => {
            const active = document.activeElement;
            const panes = PANE_SELECTORS.map((s) =>
              document.querySelector<HTMLElement>(s),
            ).filter((x): x is HTMLElement => !!x);
            const cur = panes.findIndex(
              (p) =>
                p === active ||
                (active &&
                  p
                    .closest(
                      ".ol-ribbon, .ol-folder-pane, .ol-list, .ol-reading",
                    )
                    ?.contains(active)),
            );
            const next =
              panes[(cur + (e.shiftKey ? panes.length - 1 : 1)) % panes.length];
            if (!next) return;
            if (
              !next.hasAttribute("tabindex") &&
              !/^(BUTTON|A|INPUT)$/.test(next.tagName)
            )
              next.setAttribute("tabindex", "-1");
            next.focus();
          });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function Splitter({
  onDrag,
  orientation,
}: {
  onDrag: (delta: number, done: boolean) => void;
  orientation: "vertical" | "horizontal";
}) {
  const start = useRef<number | null>(null);
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label="Resize message list"
      tabIndex={0}
      className={cn(
        "ol-splitter",
        orientation === "horizontal" && "ol-splitter-h",
      )}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        start.current = orientation === "vertical" ? e.clientX : e.clientY;
      }}
      onPointerMove={(e) => {
        if (start.current === null) return;
        const p = orientation === "vertical" ? e.clientX : e.clientY;
        onDrag(p - start.current, false);
      }}
      onPointerUp={(e) => {
        if (start.current === null) return;
        const p = orientation === "vertical" ? e.clientX : e.clientY;
        onDrag(p - start.current, true);
        start.current = null;
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft" || e.key === "ArrowUp") onDrag(-16, true);
        if (e.key === "ArrowRight" || e.key === "ArrowDown") onDrag(16, true);
      }}
    />
  );
}

export default function DesktopMail({ mail }: { mail: OutlookMail }) {
  const o = useOutlook();
  const ui = useMailUi();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const { density } = usePreferences();
  const narrow = useMedia("(max-width: 1023px)");
  const [dragW, setDragW] = useState<number | null>(null);
  const [bottomH, setBottomH] = useState(320);
  const dragRows = useRef<GroupedItem[]>([]);

  useShortcuts(mail);

  const onDrag = useCallback(
    (delta: number, done: boolean) => {
      const w = Math.max(300, Math.min(720, o.listWidth + delta));
      if (done) {
        setDragW(null);
        o.setLayout({ listWidth: w });
      } else setDragW(w);
    },
    [o],
  );

  const onDropRows = (dest: DropTarget) => {
    const rows = dragRows.current;
    dragRows.current = [];
    if (!rows.length) return;
    if (dest === "snoozed") ui.requestSnooze(rows);
    else mail.ops.moveTo(rows, dest);
  };

  // A popped-out conversation ("Open in new window") is just the reader.
  useEffect(() => {
    if (mail.popout)
      document.title = mail.openedItem?.latestSubject || document.title;
  }, [mail.popout, mail.openedItem]);
  if (mail.popout) {
    return (
      <div className="ol-mail ol-popout">
        <ReadingPane mail={mail} />
      </div>
    );
  }

  const pane = o.readingPane;
  const listWidth = dragW ?? o.listWidth;
  const showList = !(
    pane === "off" &&
    (mail.openedItem || o.compose || mail.selected.size > 1)
  );
  const showReading =
    pane !== "off" ||
    !!mail.openedItem ||
    !!o.compose ||
    mail.selected.size > 1;
  const folderOverlay = narrow && o.folderPaneOpen;

  return (
    <div
      className={cn(
        "ol-mail",
        density === "compact" && "ol-compact",
        o.spacious && density !== "compact" && "ol-spacious",
      )}
    >
      <Ribbon mail={mail} onNewMail={() => o.openCompose(null)} />
      <div className="ol-mail-body">
        {o.folderPaneOpen && (
          <>
            {folderOverlay && (
              <div
                className="ol-folder-scrim"
                onClick={() => o.setPaneOpen(false)}
                aria-hidden
              />
            )}
            <aside
              className={cn(
                "ol-folder-pane",
                folderOverlay && "ol-folder-pane-over",
              )}
              aria-label="Navigation pane"
            >
              <FolderList
                stats={mail.list.stats}
                accountEmail={session?.user?.email ?? ""}
                current={{ folder: mail.urlFolder, label: mail.label }}
                onSelect={(t) => {
                  mail.goFolder(t);
                  if (narrow) o.setPaneOpen(false);
                }}
                onOutbox={() => navigate("/outbox")}
                favorites={o.favorites}
                favoritesOpen={o.favoritesOpen}
                onFavoritesOpen={(v) => o.setLayout({ favoritesOpen: v })}
                onToggleFavorite={o.toggleFavorite}
                onMarkAllRead={(t) => void mail.ops.markAllRead(t)}
                onEmptyTrash={
                  mail.canDeleteForever
                    ? () => void mail.ops.emptyTrash()
                    : undefined
                }
                onDropRows={onDropRows}
              />
            </aside>
          </>
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          {mail.q && <SearchRefiners mail={mail} />}
          <div
            className={cn(
              "ol-panes",
              pane === "bottom" ? "flex-col" : "flex-row",
            )}
          >
            {showList && (
              <div
                className="ol-list-wrap"
                style={
                  pane === "right"
                    ? { width: listWidth }
                    : pane === "bottom"
                      ? { height: bottomH }
                      : { flex: 1 }
                }
              >
                <MessageList
                  mail={mail}
                  onDragRows={(rows) => {
                    dragRows.current = rows;
                  }}
                />
              </div>
            )}
            {showList && pane === "right" && (
              <Splitter orientation="vertical" onDrag={onDrag} />
            )}
            {showList && pane === "bottom" && (
              <Splitter
                orientation="horizontal"
                onDrag={(d, done) => {
                  if (done)
                    setBottomH((h) => Math.max(160, Math.min(640, h + d)));
                }}
              />
            )}
            {showReading && (
              <ReadingPane
                mail={mail}
                onBack={
                  pane === "off"
                    ? () => {
                        if (o.compose) o.closeCompose();
                        mail.clearSelection();
                      }
                    : undefined
                }
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
