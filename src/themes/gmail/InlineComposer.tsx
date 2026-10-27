import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Forward,
  Maximize2,
  Reply,
  ReplyAll,
  Send,
  Trash2,
} from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import {
  deleteDraft,
  replyToEmail,
  saveDraft,
  sendEmail,
  type CcEntry,
  type Email,
} from "@/lib/api";
import { dispatchEmailSent } from "@/lib/email-events";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { useDraftAutosave } from "@/lib/use-draft-autosave";
import { sendWithUndo } from "@/lib/undo-send";
import { cn } from "@/lib/utils";
import { Avatar } from "./ui";

export type InlineMode = "reply" | "replyAll" | "forward";

interface Identity {
  email: string;
  displayName: string | null;
  signatureHtml?: string | null;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Gmail's inline reply / forward box at the bottom of a conversation. It
 * shares its draft (`reply:<emailId>`) with the pop-out ReplyComposer, so
 * popping out keeps what was typed.
 */
export function InlineComposer({
  mode,
  target,
  party,
  inboxes,
  identities,
  internalDomains,
  subject,
  forwardHtml,
  meName,
  meEmail,
  onModeChange,
  onClose,
  onSent,
  onPopOut,
  onReopen,
  undoSeconds,
}: {
  /** Reopen this box (after Undo, or if the send failed). */
  onReopen: () => void;
  /** Undo Send delay (account setting). */
  undoSeconds: number;
  mode: InlineMode;
  target: Email;
  /** Who a reply goes to. */
  party: { name: string | null; email: string };
  /** Inboxes this conversation lives in (reply From choices). */
  inboxes: string[];
  identities: Identity[];
  internalDomains: string[];
  subject: string;
  /** Forwarded message block (already sanitized). */
  forwardHtml: string;
  meName?: string | null;
  meEmail?: string;
  onModeChange: (m: InlineMode) => void;
  onClose: () => void;
  onSent: () => void;
  onPopOut: (current: { bodyHtml: string; to: string; cc: CcEntry[] }) => void;
}) {
  const isForward = mode === "forward";
  const ours = useMemo(
    () => new Set(identities.map((i) => i.email.toLowerCase())),
    [identities],
  );
  const fromChoices = useMemo(() => {
    const list = inboxes.filter((i) => ours.has(i.toLowerCase()));
    return list.length ? list : identities.map((i) => i.email);
  }, [inboxes, identities, ours]);
  const defaultFrom =
    (target.type === "received" ? target.recipient : target.fromAddress) ??
    fromChoices[0] ??
    "";
  const [fromAddress, setFromAddress] = useState(defaultFrom);
  const [to, setTo] = useState(isForward ? "" : party.email);
  const [cc, setCc] = useState<CcEntry[]>(() =>
    mode === "replyAll"
      ? (target.cc ?? []).filter((c) => !ours.has(c.email.toLowerCase()))
      : [],
  );
  const [showCc, setShowCc] = useState(mode === "replyAll" && cc.length > 0);
  const [bodyHtml, setBodyHtml] = useState(isForward ? forwardHtml : "");
  const [bodyText, setBodyText] = useState("");
  const [error, setError] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setShowCc(mode === "replyAll" && cc.length > 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // Focus the editor when the box opens, and bring it into view.
  useEffect(() => {
    const el = wrapRef.current;
    const t = window.setTimeout(() => {
      if (!isForward)
        el?.querySelector<HTMLElement>("[contenteditable=true]")?.focus({
          preventScroll: true,
        });
      el?.scrollIntoView({ block: "end", behavior: "smooth" });
    }, 120);
    return () => window.clearTimeout(t);
  }, []);

  const empty = !bodyHtml || bodyHtml === "<p></p>";
  const { clear } = useDraftAutosave({
    contextKey: isForward ? `forward:${target.id}` : `reply:${target.id}`,
    enabled: true,
    isEmpty: isForward ? bodyHtml === forwardHtml || empty : empty,
    restore: true,
    values: isForward
      ? { fromAddress, to, cc, subject: `Fwd: ${subject}`, bodyHtml, bodyText }
      : { fromAddress, cc, bodyHtml, bodyText, replyToEmailId: target.id },
    onRestore: (d) => {
      if (d.bodyHtml) setBodyHtml(d.bodyHtml);
      if (d.bodyText) setBodyText(d.bodyText);
      if (d.cc?.length) {
        setCc(d.cc);
        setShowCc(true);
      }
      if (d.fromAddress) setFromAddress(d.fromAddress);
      if (d.toAddress) setTo(d.toAddress);
    },
  });

  const signature = useMemo(() => {
    const id = identities.find((i) => i.email === fromAddress);
    return id?.signatureHtml ? sanitizeEmailHtml(id.signatureHtml) : null;
  }, [identities, fromAddress]);

  const contextKey = isForward ? `forward:${target.id}` : `reply:${target.id}`;

  // Send closes the box at once and hands off to sendWithUndo, so there's
  // no in-flight state to guard here.
  const send = () => {
    setError("");
    const finalBody = signature
      ? `${bodyHtml}<div data-signature>${signature}</div>`
      : bodyHtml;
    const recipients = to
      .split(/[,;\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (isForward) {
      if (!recipients.length || !recipients.every((r) => EMAIL_RE.test(r))) {
        setError("Add a valid recipient");
        return;
      }
    } else if (empty) {
      setError("Write a reply first");
      return;
    }
    // Keep the draft until the real send succeeds, so Undo (or a failed
    // send) reopens the box with everything in it.
    const kept = saveDraft({
      contextKey,
      fromAddress,
      cc,
      bodyHtml,
      bodyText,
      ...(isForward
        ? { to, subject: `Fwd: ${subject}` }
        : { replyToEmailId: target.id }),
    }).catch(() => null);
    const payloadCc = cc.length ? cc : undefined;
    const text = bodyText.trim() ? { bodyText } : {};
    onClose();
    sendWithUndo({
      seconds: undoSeconds,
      label: isForward ? "Forwarding…" : "Sending…",
      send: async () => {
        if (isForward) {
          for (const r of recipients) {
            await sendEmail({
              to: r,
              fromAddress,
              cc: payloadCc,
              subject: `Fwd: ${subject}`,
              bodyHtml: finalBody,
              ...text,
            });
          }
        } else {
          await replyToEmail(target.id, {
            bodyHtml: finalBody,
            ...text,
            fromAddress,
            ...(payloadCc ? { cc: payloadCc } : {}),
          });
        }
      },
      onUndo: () => {
        void kept.then(() => onReopen());
      },
      onSent: () => {
        void kept.then(() => deleteDraft(contextKey).catch(() => {}));
        dispatchEmailSent({
          fromAddress,
          to: isForward ? recipients[0] : party.email,
          origin: isForward ? "compose" : "reply",
        });
        onSent();
      },
      onError: () => {
        void kept.then(() => onReopen());
      },
    });
  };

  const ModeIcon =
    mode === "forward" ? Forward : mode === "replyAll" ? ReplyAll : Reply;

  return (
    <div
      ref={wrapRef}
      className="flex scroll-mb-6 gap-3"
      data-testid="gmail-inline-composer"
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          send();
        }
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <Avatar name={meName} email={meEmail} size={40} className="mt-1" />
      <div className="min-w-0 flex-1 rounded-[8px] shadow-raised">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1 text-sm">
          <label className="relative flex items-center">
            <span className="sr-only">Reply type</span>
            <ModeIcon
              size={18}
              className="pointer-events-none absolute left-2 text-text-secondary"
            />
            <select
              value={mode}
              onChange={(e) => onModeChange(e.target.value as InlineMode)}
              className="h-8 appearance-none rounded-[4px] bg-transparent pl-8 pr-6 text-sm hover:bg-bg-muted"
              aria-label="Reply type"
              data-testid="gmail-inline-mode"
            >
              <option value="reply">Reply</option>
              <option value="replyAll">Reply all</option>
              <option value="forward">Forward</option>
            </select>
            <ChevronDown
              size={14}
              className="pointer-events-none absolute right-1.5 text-text-secondary"
            />
          </label>
          {isForward ? (
            <input
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="To"
              aria-label="To"
              className="h-8 min-w-0 flex-1 bg-transparent px-2 outline-none"
              data-testid="gmail-inline-to"
              autoFocus
            />
          ) : (
            <span className="min-w-0 flex-1 truncate px-2">
              {party.name ? `${party.name} <${party.email}>` : party.email}
            </span>
          )}
          {!showCc && (
            <button
              type="button"
              className="rounded px-2 text-xs text-text-secondary hover:underline"
              onClick={() => setShowCc(true)}
            >
              Cc
            </button>
          )}
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Pop out reply"
            title="Pop out reply"
            onClick={() => onPopOut({ bodyHtml, to, cc })}
            data-testid="gmail-inline-popout"
          >
            <Maximize2 size={16} />
          </button>
        </div>
        {showCc && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-sm">
            <span className="text-text-secondary">Cc</span>
            <div className="min-w-0 flex-1">
              <CcInput
                value={cc}
                onChange={setCc}
                internalDomains={internalDomains}
                placeholder="Add people"
              />
            </div>
          </div>
        )}
        {fromChoices.length > 1 && (
          <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-sm">
            <span className="text-text-secondary">From</span>
            <select
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              className="h-8 min-w-0 flex-1 bg-transparent outline-none"
              aria-label="From"
            >
              {fromChoices.map((f) => {
                const id = identities.find((i) => i.email === f);
                return (
                  <option key={f} value={f}>
                    {id?.displayName ? `${id.displayName} <${f}>` : f}
                  </option>
                );
              })}
            </select>
          </div>
        )}
        <div className="gm-inline-editor px-1">
          <TiptapEditor
            content={bodyHtml}
            onUpdate={(html, text) => {
              setBodyHtml(html);
              setBodyText(text);
            }}
            placeholder={isForward ? "" : "Write your reply…"}
          />
        </div>
        {signature && (
          <div
            className="gm-msg-body px-4 pb-2 text-sm text-text-secondary"
            dangerouslySetInnerHTML={{ __html: `-- <br/>${signature}` }}
          />
        )}
        {error && (
          <p className="px-4 pb-2 text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2 px-3 pb-3 pt-1">
          <button
            type="button"
            onClick={send}
            className={cn(
              "inline-flex h-9 items-center gap-2 rounded-full bg-accent px-5 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-60",
            )}
            title="Send (Ctrl+Enter)"
            data-testid="gmail-inline-send"
          >
            Send
            <Send size={16} />
          </button>
          <div className="flex-1" />
          <button
            type="button"
            className="gm-icon-btn gm-sm"
            aria-label="Discard draft"
            title="Discard draft"
            onClick={() => {
              clear();
              onClose();
            }}
          >
            <Trash2 size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
