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
  UserPen,
  Check,
} from "lucide-react";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import ThreadMessage from "@/components/ThreadMessage";
import ImageAttachments, {
  splitAttachments,
} from "@/components/ImageAttachments";
import {
  fetchPersonEmails,
  fetchStats,
  reassignEmailPerson,
  type Email,
} from "@/lib/api";
import { showToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { avatarColor } from "@/lib/avatar";

interface EmailHtmlModalProps {
  email: Email | null;
  open: boolean;
  onClose: () => void;
  /** Called after the message's From/To (person) is changed in-place. */
  onUpdated?: () => void;
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

export default function EmailHtmlModal({
  email,
  open,
  onClose,
  onUpdated,
}: EmailHtmlModalProps) {
  const [view, setView] = useState<"rendered" | "plain">("rendered");
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // In-place re-targeting of who this message is from/to (and, for sent
  // messages, the reply recipient). See the editable From/To rows below.
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const [toVal, setToVal] = useState("");
  const [fromVal, setFromVal] = useState("");
  const [identities, setIdentities] = useState<string[]>([]);
  // Local overrides so the modal reflects a save without waiting on the parent.
  const [override, setOverride] = useState<{
    from?: string;
    to?: string;
  } | null>(null);
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
    setEditing(false);
    setEditErr(null);
    setOverride(null);
  }, [email?.id]);

  // Sender identities power the "From" dropdown when re-targeting a sent
  // message. Loaded once per open; harmless for received messages.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchStats()
      .then((s) => {
        if (!cancelled)
          setIdentities((s.senderIdentities ?? []).map((i) => i.email));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

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
  const { images, files: downloadable } = splitAttachments(email.attachments);
  const attachmentCount = images.length + downloadable.length;
  // `override` reflects an in-place edit before the parent refetches. Inline
  // From/To editing is offered for SENT messages (the contact-form case);
  // received messages re-attribute via the per-message Reassign action.
  const fromAddr = override?.from ?? email.fromAddress;
  const toAddr = override?.to ?? (isSent ? email.toAddress : email.recipient);
  const canEdit = isSent;
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

  function startEdit() {
    setToVal(toAddr ?? "");
    setFromVal(fromAddr ?? "");
    setEditErr(null);
    setEditing(true);
  }

  async function saveEdit() {
    if (!email) return;
    const body: { email?: string; fromAddress?: string } = {};
    const newTo = toVal.trim().toLowerCase();
    const newFrom = fromVal.trim().toLowerCase();
    if (newTo && newTo !== (toAddr ?? "").toLowerCase()) body.email = newTo;
    if (newFrom && newFrom !== (fromAddr ?? "").toLowerCase())
      body.fromAddress = newFrom;
    if (!body.email && !body.fromAddress) {
      setEditing(false);
      return;
    }
    setSaving(true);
    setEditErr(null);
    try {
      const res = await reassignEmailPerson(email.id, body);
      setOverride({
        ...(res.email.toAddress != null ? { to: res.email.toAddress } : {}),
        ...(res.email.fromAddress != null
          ? { from: res.email.fromAddress }
          : {}),
      });
      setEditing(false);
      showToast({
        kind: "success",
        message: body.email
          ? `Recipient set to ${body.email}`
          : "Sending address updated",
        description: body.email
          ? "Replies to this message will now go there."
          : undefined,
        durationMs: 4500,
      });
      onUpdated?.();
    } catch {
      setEditErr("Couldn't save — check the addresses and try again.");
    } finally {
      setSaving(false);
    }
  }

  // From options: the current sender first, then the other identities.
  const fromOptions = Array.from(
    new Set([fromAddr, ...identities].filter(Boolean) as string[]),
  );

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
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card pl-3.5 pr-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                style={{ backgroundColor: color.bg, color: color.fg }}
              >
                {avatarInitial(senderForAvatar)}
              </span>
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                {email.subject || "(no subject)"}
              </DialogPrimitive.Title>
              <span
                className={cn(
                  "pt-chip hidden shrink-0 sm:inline-flex",
                  !isSent && "accent",
                )}
              >
                {isSent ? <Send size={11} /> : <InboxIcon size={11} />}
                {isSent ? "Sent" : "Received"}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <TrayMaximizeButton
                fullscreen={fullscreen}
                onToggle={() => setFullscreen((v) => !v)}
              />
              <DialogPrimitive.Close
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                aria-label="Close"
              >
                <X size={14} />
              </DialogPrimitive.Close>
            </div>
          </div>

          {/* Compact metadata. */}
          <div className="shrink-0 divide-y divide-border-subtle border-b border-border bg-card">
            <TrayMetaRow label="From">
              {editing && canEdit ? (
                <select
                  value={fromVal}
                  onChange={(e) => setFromVal(e.target.value)}
                  className="my-1 h-8 w-full rounded-lg border border-border-strong bg-card px-2 text-sm text-text-primary shadow-card outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
                >
                  {fromOptions.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="flex items-center justify-between gap-2 pr-3">
                  <span className="block truncate py-2.5 text-sm text-text-primary">
                    {fromAddr || (isSent ? "you" : "—")}
                  </span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={startEdit}
                      data-testid="view-edit-recipient"
                      title="Change From / To"
                      className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
                    >
                      <UserPen size={13} />
                    </button>
                  )}
                </div>
              )}
            </TrayMetaRow>
            <TrayMetaRow label="To">
              {editing && canEdit ? (
                <input
                  type="email"
                  value={toVal}
                  onChange={(e) => setToVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveEdit();
                  }}
                  placeholder="recipient@example.com"
                  className="my-1 h-8 w-full rounded-lg border border-border-strong bg-card px-2 text-sm text-text-primary shadow-card outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
                />
              ) : (
                <span className="block truncate py-2.5 pr-3 text-sm text-text-primary">
                  {toAddr || "—"}
                </span>
              )}
            </TrayMetaRow>
            {editing && canEdit && (
              <div className="flex items-center justify-end gap-2 px-3 py-2">
                {editErr && (
                  <span className="mr-auto text-xs text-destructive">
                    {editErr}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setEditing(false)}
                  className="inline-flex h-8 items-center rounded-lg px-3 text-[13px] font-medium text-text-secondary hover:bg-bg-muted hover:text-text-primary"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEdit}
                  disabled={saving}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-foreground shadow-card hover:bg-accent-hover disabled:opacity-50"
                >
                  <Check size={12} />
                  {saving ? "Saving…" : "Save"}
                </button>
              </div>
            )}
            <TrayMetaRow label="Time">
              <span className="block truncate py-2.5 pr-3 text-sm text-text-primary">
                {fullDate} · {fullTime}
              </span>
            </TrayMetaRow>
            <TrayMetaRow label="ID">
              <span className="font-code block truncate py-2.5 pr-3 text-xs text-text-tertiary">
                {email.id}
              </span>
            </TrayMetaRow>
          </div>

          {/* Attachments */}
          {attachmentCount > 0 && (
            <div className="shrink-0 border-b border-border bg-card px-4 py-2.5 sm:px-5">
              <p className="font-label mb-2 text-text-tertiary">
                {attachmentCount} attachment
                {attachmentCount !== 1 ? "s" : ""}
              </p>
              <ImageAttachments
                images={images}
                className={downloadable.length > 0 ? "mb-2" : undefined}
              />
              <ul className="space-y-1.5">
                {downloadable.map((att) => (
                  <li key={att.id}>
                    <a
                      href={`/api/attachments/${att.id}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2 text-[13px] shadow-card transition-colors hover:bg-bg-subtle"
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
                        <span className="tabular text-xs">
                          {formatBytes(att.size)}
                        </span>
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
              <div className="pt-seg">
                <button
                  onClick={() => setView("rendered")}
                  aria-pressed={view === "rendered"}
                  className={cn(view === "rendered" && "on")}
                >
                  <FileText size={13} />
                  Rendered
                </button>
                <button
                  onClick={() => setView("plain")}
                  aria-pressed={view === "plain"}
                  className={cn(view === "plain" && "on")}
                >
                  <Code size={13} />
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-strong bg-card px-2.5 text-[13px] font-medium text-text-secondary shadow-card transition-colors hover:text-text-primary"
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
                <span className="inline-flex items-center gap-1.5 text-xs text-text-tertiary">
                  <MessageSquare size={11} />
                  Loading thread…
                </span>
              )}
            </div>
            <button
              onClick={handleCopy}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
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
              <div className="border-b border-border bg-bg-subtle">
                <div className="flex items-center gap-2 px-4 py-2 sm:px-5">
                  <MessageSquare size={13} className="text-text-secondary" />
                  <span className="font-label text-[10.5px] text-text-tertiary">
                    {priorEmails.length} earlier message
                    {priorEmails.length === 1 ? "" : "s"} in this thread
                  </span>
                </div>
                <div className="divide-y divide-border-subtle">
                  {priorEmails.map((e) => (
                    <ThreadMessage key={e.id} email={e} muted />
                  ))}
                </div>
                <div className="flex items-center gap-2 border-t border-border bg-card px-4 py-2 sm:px-5">
                  <ChevronDown size={13} className="text-text-secondary" />
                  <span className="font-label text-[10.5px] text-text-tertiary">
                    This message
                  </span>
                </div>
              </div>
            )}
            {view === "rendered" && email.bodyHtml ? (
              <div
                className="email-surface m-3 max-w-none overflow-x-auto rounded-lg px-5 py-4 sm:m-4 text-sm leading-relaxed [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--sm-email-line)] [&_blockquote]:pl-3 [&_img]:max-w-full [&_p]:my-2 sm:px-7 sm:py-5"
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
          <div className="hidden shrink-0 items-center justify-between gap-2 border-t border-border bg-card px-4 py-2 sm:flex sm:px-5">
            <p className="text-xs text-text-tertiary">
              Press{" "}
              <kbd className="rounded border border-border bg-bg-subtle px-1 font-sans text-[11px]">
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
