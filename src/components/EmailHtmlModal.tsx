import { useEffect, useMemo, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  X,
  Paperclip,
  Download,
  Copy,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Inbox as InboxIcon,
  MessageSquare,
  Send,
  FileText,
  Code,
} from "lucide-react";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import ThreadMessage from "@/components/ThreadMessage";
import { fetchPersonEmails, type Email } from "@/lib/api";
import { cn } from "@/lib/utils";

interface EmailHtmlModalProps {
  email: Email | null;
  open: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function avatarInitial(addr: string | null): string {
  if (!addr) return "?";
  return addr[0]?.toUpperCase() ?? "?";
}

function avatarColor(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const palette = [
    { bg: "rgba(124, 92, 252, 0.14)", fg: "#5b3ce6" },
    { bg: "rgba(34, 197, 94, 0.14)", fg: "#15803d" },
    { bg: "rgba(244, 114, 182, 0.16)", fg: "#be185d" },
    { bg: "rgba(56, 189, 248, 0.16)", fg: "#0369a1" },
    { bg: "rgba(168, 85, 247, 0.14)", fg: "#7e22ce" },
  ];
  return palette[h % palette.length];
}

export default function EmailHtmlModal({
  email,
  open,
  onClose,
}: EmailHtmlModalProps) {
  const [view, setView] = useState<"rendered" | "plain">("rendered");
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Surrounding thread (oldest → newest, including the focal message
  // we re-filter at render time). Always loadable so even chat-mode
  // viewers can see prior messages without leaving the modal.
  const [threadEmails, setThreadEmails] = useState<Email[]>([]);
  const [threadExpanded, setThreadExpanded] = useState(false);
  const [threadLoading, setThreadLoading] = useState(false);

  // Reset internal state when the email changes. Previously this
  // was a `useMemo`-as-side-effect, which is wrong for two reasons:
  // it calls setState during render (React 18+ warns + double-runs
  // under StrictMode), and it runs *before* the new render rather
  // than after, which can leave the focal email's body briefly
  // rendered with the previous thread's expansion state. useEffect
  // gives us the post-render reset point React intends.
  useEffect(() => {
    setView("rendered");
    setCopied(false);
    setFullscreen(false);
    setThreadExpanded(false);
    setThreadEmails([]);
  }, [email?.id]);

  // Load the surrounding thread for this person + inbox when the
  // modal opens. Same call ReplyComposer makes — the response gives
  // us all received + sent emails for that person, scoped to the
  // recipient inbox so we don't leak cross-inbox traffic.
  useEffect(() => {
    if (!open || !email?.personId) return;
    let cancelled = false;
    setThreadLoading(true);
    const recipient = email.recipient ?? email.fromAddress ?? undefined;
    fetchPersonEmails(email.personId, { recipient, limit: 25 })
      .then((res) => {
        if (cancelled) return;
        setThreadEmails(res.emails);
      })
      .catch((err) => {
        // Non-fatal — the body still renders fine without thread context.
        console.warn("Failed to load thread context for view-original", err);
      })
      .finally(() => {
        if (!cancelled) setThreadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, email?.id, email?.personId, email?.recipient, email?.fromAddress]);

  // Older messages in the same thread, oldest → newest, excluding the
  // focal message itself (it's already rendered as the modal body).
  // Computed before the `if (!email) return null` early-return so the
  // hook count stays constant across renders — crucial for Rules of
  // Hooks. Returns [] when email is null.
  const priorEmails = useMemo(() => {
    if (!email) return [];
    return threadEmails
      .filter((e) => e.id !== email.id && e.timestamp <= email.timestamp)
      .sort((a, b) => a.timestamp - b.timestamp);
  }, [threadEmails, email]);
  const hasThreadContext = priorEmails.length > 0;

  if (!email) return null;

  const isSent = email.type === "sent";
  const downloadable = (email.attachments ?? []).filter((a) => !a.contentId);
  const fromAddr = isSent ? email.fromAddress : email.fromAddress;
  const toAddr = isSent ? email.toAddress : email.recipient;
  const senderForAvatar = isSent ? "you" : (fromAddr ?? email.recipient ?? "?");
  const color = avatarColor(senderForAvatar);

  const ts = new Date(email.timestamp * 1000);
  const fullDate = ts.toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const fullTime = ts.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });

  const plainText =
    email.bodyText ||
    (email.bodyHtml
      ? (new DOMParser().parseFromString(email.bodyHtml, "text/html").body
          .textContent ?? "")
      : "");

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    // Non-modal tray (Gmail-style): the inbox stays interactive while
    // viewing the original message. Slightly wider than the compose
    // family because email content is often paragraph-heavy.
    <DialogPrimitive.Root
      open={open}
      modal={false}
      onOpenChange={(v) => !v && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tray-overlay fixed inset-0 z-50" />
        <DialogPrimitive.Content
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className={trayContentClass({ fullscreen, width: "viewer" })}
        >
          {/* Slim header — avatar + subject inline. */}
          <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border bg-card pl-3 pr-3">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                style={{ backgroundColor: color.bg, color: color.fg }}
              >
                {avatarInitial(senderForAvatar)}
              </span>
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                {email.subject || "(no subject)"}
              </DialogPrimitive.Title>
              <span
                className={cn(
                  "hidden shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider sm:inline-flex",
                  isSent ? "bg-bg-muted text-text-secondary" : "bg-violet/10",
                )}
                style={!isSent ? { color: "#7c5cfc" } : undefined}
              >
                {isSent ? <Send size={9} /> : <InboxIcon size={9} />}
                {isSent ? "Sent" : "Received"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <TrayMaximizeButton
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((v) => !v)}
              />
              <DialogPrimitive.Close
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[6px] text-text-tertiary transition-colors hover:bg-bg-muted hover:text-text-primary"
                aria-label="Close"
              >
                <X size={14} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Compact metadata. */}
          <div className="shrink-0 divide-y divide-border/60 border-b border-border bg-bg-subtle/30">
            <TrayMetaRow label="From">
              <span className="block truncate py-2 pr-3 text-sm text-text-primary">
                {fromAddr || (isSent ? "you" : "—")}
              </span>
            </TrayMetaRow>
            <TrayMetaRow label="To">
              <span className="block truncate py-2 pr-3 text-sm text-text-primary">
                {toAddr || "—"}
              </span>
            </TrayMetaRow>
            <TrayMetaRow label="Time">
              <span className="block truncate py-2 pr-3 text-sm text-text-primary">
                {fullDate} · {fullTime}
              </span>
            </TrayMetaRow>
            <TrayMetaRow label="ID">
              <span className="block truncate py-2 pr-3 font-mono text-xs text-text-tertiary">
                {email.id}
              </span>
            </TrayMetaRow>
          </div>

          {/* Attachments */}
          {downloadable.length > 0 && (
            <div className="shrink-0 border-b border-border bg-card px-4 py-2.5 sm:px-5">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                {downloadable.length} attachment
                {downloadable.length !== 1 ? "s" : ""}
              </p>
              <ul className="space-y-1.5">
                {downloadable.map((att) => (
                  <li key={att.id}>
                    <a
                      href={`/api/attachments/${att.id}`}
                      className="flex items-center justify-between gap-3 rounded-[8px] border border-border bg-card px-3 py-2 text-xs transition-colors hover:bg-bg-muted"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <Paperclip
                          size={14}
                          className="shrink-0 text-text-tertiary"
                        />
                        <span className="truncate font-medium text-text-primary">
                          {att.filename}
                        </span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-text-tertiary">
                        <span>{formatBytes(att.size)}</span>
                        <Download size={12} />
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Body view toggle + actions */}
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-4 py-2 sm:px-5">
            <div className="flex items-center gap-2">
              <div className="inline-flex rounded-[8px] bg-bg-muted/70 p-0.5 ring-1 ring-border">
                <button
                  onClick={() => setView("rendered")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-xs font-medium transition-all",
                    view === "rendered"
                      ? "bg-card text-text-primary shadow-sm"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  <FileText size={12} />
                  Rendered
                </button>
                <button
                  onClick={() => setView("plain")}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1 text-xs font-medium transition-all",
                    view === "plain"
                      ? "bg-card text-text-primary shadow-sm"
                      : "text-text-secondary hover:text-text-primary",
                  )}
                >
                  <Code size={12} />
                  Plain text
                </button>
              </div>
              {/* Thread expansion. Always available when this email is
                  part of a person's thread — including from chat mode,
                  per the user's "always make it possible" requirement. */}
              {hasThreadContext && (
                <button
                  type="button"
                  onClick={() => setThreadExpanded((v) => !v)}
                  aria-expanded={threadExpanded}
                  className="inline-flex items-center gap-1.5 rounded-[6px] border border-border bg-card px-2.5 py-1 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                >
                  <MessageSquare size={12} />
                  {threadExpanded ? "Hide" : "Show"} {priorEmails.length}{" "}
                  earlier
                  {threadExpanded ? (
                    <ChevronUp size={12} />
                  ) : (
                    <ChevronDown size={12} />
                  )}
                </button>
              )}
              {!hasThreadContext && threadLoading && (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-light text-text-tertiary">
                  <MessageSquare size={11} />
                  Loading thread…
                </span>
              )}
            </div>
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 rounded-[8px] px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
            >
              {copied ? (
                <>
                  <CheckCircle2 size={12} className="text-success" />
                  Copied
                </>
              ) : (
                <>
                  <Copy size={12} />
                  Copy text
                </>
              )}
            </button>
          </div>

          {/* Body — prior thread (when expanded) sits above the focal
              message so older context flows naturally into the
              current rendering. */}
          <div className="smooth-scroll min-h-0 flex-1 overflow-y-auto bg-card">
            {threadExpanded && hasThreadContext && (
              <div className="border-b border-border bg-bg-subtle/30">
                <div className="flex items-center gap-2 px-4 py-2 sm:px-5">
                  <MessageSquare size={11} className="text-text-tertiary" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                    {priorEmails.length} earlier message
                    {priorEmails.length === 1 ? "" : "s"} in this thread
                  </span>
                </div>
                <div className="divide-y divide-border/60">
                  {priorEmails.map((e) => (
                    <ThreadMessage key={e.id} email={e} muted />
                  ))}
                </div>
                <div className="flex items-center gap-2 border-t border-border bg-card px-4 py-2 sm:px-5">
                  <ChevronDown size={11} className="text-text-tertiary" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-text-tertiary">
                    This message
                  </span>
                </div>
              </div>
            )}
            {view === "rendered" && email.bodyHtml ? (
              <div
                className="prose prose-sm max-w-none px-5 py-4 text-text-primary [&_a]:text-violet [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-text-secondary [&_p]:my-2 sm:px-7 sm:py-5"
                style={{ "--tw-prose-links": "#7c5cfc" } as React.CSSProperties}
                dangerouslySetInnerHTML={{
                  __html: sanitizeEmailHtml(email.bodyHtml),
                }}
              />
            ) : (
              <pre className="whitespace-pre-wrap break-words px-5 py-4 font-sans text-sm leading-relaxed text-text-primary sm:px-7 sm:py-5">
                {plainText || "(empty)"}
              </pre>
            )}
          </div>

          {/* Slim footer — single-line Esc hint. */}
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-4 py-2 sm:px-5">
            <p className="text-[11px] font-light text-text-tertiary">
              Press{" "}
              <kbd className="rounded border border-border bg-bg-muted px-1 font-mono text-[10px]">
                Esc
              </kbd>{" "}
              to close
            </p>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
