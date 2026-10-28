import {
  beginSend,
  finishSend,
  forgetSendKey,
  sendKeyProblem,
} from "@/lib/send-key";
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, PenSquare, Send, X } from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import {
  sendEmail,
  fetchStats,
  deleteDraft,
  type CcEntry,
  type EmailTemplate,
} from "@/lib/api";
import RecipientInput from "@/components/RecipientInput";
import { TemplatePicker, TemplateVarsBar } from "@/components/ComposeTemplates";
import { sendWithUndo } from "@/lib/undo-send";
import { useCommonSettings } from "@/lib/default-layout-settings";
import { useDraftAutosave } from "@/lib/use-draft-autosave";
import { dispatchEmailSent } from "@/lib/email-events";
import { getFromLabel } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import AttachmentPicker from "@/components/AttachmentPicker";
import SendingPausedNotice from "@/components/SendingPausedNotice";
import AttachmentChips from "@/components/AttachmentChips";

// Effective backend cap is ~18MB on the Cloudflare email path; we cap the
// UI at 25MB and let the server reject the rest with a clear 413.
const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Optional seed values applied when the compose drawer opens. Used by
 * the chat-mode "open in compose" handoff so a user can switch from
 * the bottom-of-thread quick reply to the full editor without losing
 * context (sender, recipient, CC roster, subject).
 *
 * Any field omitted falls back to the drawer's regular default —
 * `from` defaults to the user's first inbox; `to`/`cc`/`subject`/`bodyHtml`
 * default to empty.
 */
export interface ComposePrefill {
  from?: string;
  to?: string;
  cc?: CcEntry[];
  subject?: string;
  bodyHtml?: string;
  /** Plain-text part to go with bodyHtml (an undone send reopens with it). */
  bodyText?: string;
  /** Attachments (an undone or failed send reopens with them). */
  files?: File[];
  /** Shown in the footer, e.g. why the last send failed. */
  error?: string;
}

interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  prefill?: ComposePrefill | null;
  /** Draft slot of this window ("compose" unless the caller names one). */
  contextKey?: string;
  /**
   * Reopen the composer with this content. Undo Send needs it: the
   * composer closes as soon as Send is pressed and comes back on Undo or
   * when the send fails. Without it, sends go out at once (no Undo).
   */
  onReopen?: (prefill: ComposePrefill, contextKey?: string) => void;
}

/**
 * Compose drawer — opens from the right edge to match ReplyComposer.
 * Single "Freeform" mode for now (no template support); structurally
 * mirrors the reply experience so the two feel like the same component.
 */
export default function ComposeModal({
  open,
  onClose,
  prefill,
  contextKey = "compose",
  onReopen,
}: ComposeModalProps) {
  const [{ undoSendSeconds }] = useCommonSettings();
  const openRef = useRef(open);
  openRef.current = open;
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const [to, setTo] = useState("");
  const [fromAddress, setFromAddress] = useState("");
  const [cc, setCc] = useState<CcEntry[]>([]);
  const [recipients, setRecipients] = useState<string[]>([]);
  const [senderIdentities, setSenderIdentities] = useState<
    Array<{
      email: string;
      displayName: string | null;
      signatureHtml: string | null;
    }>
  >([]);
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  // Plain-text rendering of the editor, kept in lockstep with bodyHtml so the
  // outgoing mail ships a `text/plain` part — same shape the reply composers
  // send. Also what the chat feed keys off to render a normal bubble rather
  // than the HTML preview card.
  const [bodyText, setBodyText] = useState("");
  // Tracked separately from the body so swapping `From` mid-compose can swap
  // the signature without stomping on what the user has typed.
  const [signatureHtml, setSignatureHtml] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Compact tray vs. full-viewport. Toggled by the maximize button in
  // the header; reset every time the drawer reopens.
  const [fullscreen, setFullscreen] = useState(false);
  // Recipient chosen from suggestions (its name prefills template fields).
  const [toPerson, setToPerson] = useState<{
    email: string;
    name: string | null;
  } | null>(null);
  const [pendingTemplate, setPendingTemplate] = useState<EmailTemplate | null>(
    null,
  );
  // While the To suggestions show, Esc closes them, not the window.
  const [suggesting, setSuggesting] = useState(false);
  const onSuggestingChange = useCallback((v: boolean) => setSuggesting(v), []);

  // Domains we own — used for the lime/neutral CC chip color.
  const internalDomains = useMemo(() => {
    const set = new Set<string>();
    for (const s of senderIdentities) {
      const at = s.email.lastIndexOf("@");
      if (at >= 0) set.add(s.email.slice(at + 1).toLowerCase());
    }
    return Array.from(set);
  }, [senderIdentities]);

  // TipTap emits "<p></p>" for an empty editor — treat that as empty.
  const bodyIsEmpty = !bodyHtml || bodyHtml === "<p></p>";

  const totalAttachmentBytes = files.reduce((s, f) => s + f.size, 0);

  // Sanitize the signature once per change, then reuse for both the
  // preview pane and the outbound concatenation. The server also
  // sanitizes on write — this is defense-in-depth for browser
  // execution paths (preview pane uses dangerouslySetInnerHTML).
  const safeSignatureHtml = useMemo(
    () => (signatureHtml ? sanitizeEmailHtml(signatureHtml) : null),
    [signatureHtml],
  );

  useEffect(() => {
    if (open) {
      fetchStats().then((stats) => {
        setRecipients(stats.recipients);
        setSenderIdentities(stats.senderIdentities ?? []);
        // Prefill `from` wins; otherwise keep whatever is already set (sticky
        // from last open, or a restored draft's sender that landed before
        // this response); finally fall back to the first inbox.
        const want = prefill?.from;
        if (want && stats.recipients.includes(want)) {
          setFromAddress(want);
        } else if (stats.recipients.length > 0) {
          setFromAddress((current) => current || stats.recipients[0]);
        }
      });
      // Apply any seeded values up front. Fields the caller didn't
      // specify stay empty — same as a fresh "Compose" click.
      setTo(prefill?.to ?? "");
      setCc(prefill?.cc ?? []);
      setSubject(prefill?.subject ?? "");
      setBodyHtml(prefill?.bodyHtml ?? "");
      setBodyText(prefill?.bodyText ?? "");
      setFiles(prefill?.files ?? []);
      setError(prefill?.error ?? "");
    } else {
      setTo("");
      setCc([]);
      setSubject("");
      setBodyHtml("");
      setBodyText("");
      setSignatureHtml(null);
      setError("");
      setFullscreen(false);
      setFiles([]);
      setPendingTemplate(null);
      setToPerson(null);
    }
    // We intentionally don't track `fromAddress` here — it's only used
    // as a sticky fallback above, not as a trigger to re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, prefill]);

  // Whenever the From inbox or the loaded identity list changes, swap the
  // signature trail to match. Stays a separate state slot so the user's
  // typed body never gets clobbered.
  useEffect(() => {
    if (!fromAddress) {
      setSignatureHtml(null);
      return;
    }
    const match = senderIdentities.find((s) => s.email === fromAddress);
    setSignatureHtml(match?.signatureHtml ?? null);
  }, [fromAddress, senderIdentities]);

  // Autosave a "half-written" draft so it survives closing the composer.
  // Restore only on a plain open — an explicit prefill (e.g. the chat
  // "open in compose" handoff) should win over a stale draft.
  const composeIsEmpty = !to.trim() && !subject.trim() && bodyIsEmpty;
  const hasPrefill = !!(
    prefill &&
    (prefill.to ||
      prefill.subject ||
      prefill.bodyHtml ||
      (prefill.cc && prefill.cc.length > 0))
  );
  const { clear: clearDraft, status: draftStatus } = useDraftAutosave({
    contextKey,
    enabled: open,
    isEmpty: composeIsEmpty,
    restore: open && !hasPrefill,
    values: { fromAddress, to, cc, subject, bodyHtml, bodyText },
    onRestore: (draft) => {
      if (draft.toAddress) setTo(draft.toAddress);
      if (draft.cc) setCc(draft.cc);
      if (draft.subject) setSubject(draft.subject);
      if (draft.bodyHtml) setBodyHtml(draft.bodyHtml);
      if (draft.bodyText) setBodyText(draft.bodyText);
      if (draft.fromAddress) setFromAddress(draft.fromAddress);
    },
  });

  const sendContext = `send:${contextKey}`;
  // Closing the window ends this message: the next one gets a new key. Only
  // a close does: after a reload the window starts closed, and a retry from
  // the restored draft must keep the key. A send held for Undo or in flight
  // keeps its key through the close (the window closes as soon as Send is
  // pressed); only its own success or Undo forgets it.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (wasOpen.current && !open) forgetSendKey(sendContext);
    wasOpen.current = open;
  }, [open, sendContext]);

  function handleSend() {
    if (!to || bodyIsEmpty || sending) return;
    setError("");
    // Concatenate the typed body + auto-attached signature on send.
    // The signature is wrapped in `data-signature` so the chat-feed
    // toggle can strip it back out cleanly.
    // Use the sanitized signature — even the outbound payload that
    // never touches the browser DOM gets the cleaned version.
    const finalBody = safeSignatureHtml
      ? `${bodyHtml}<div data-signature>${safeSignatureHtml}</div>`
      : bodyHtml;
    const payload = {
      to,
      fromAddress,
      ...(cc.length > 0 ? { cc } : {}),
      subject,
      bodyHtml: finalBody,
      ...(bodyText.trim() ? { bodyText } : {}),
      ...(files.length > 0 ? { files: files.map((file) => ({ file })) } : {}),
    };
    // What the composer reopens with on Undo or on failure.
    const snapshot: ComposePrefill = {
      from: fromAddress,
      to,
      cc,
      subject,
      bodyHtml,
      bodyText,
      files,
    };
    const failure =
      "Couldn't send. Your draft is saved; check the address and try again.";
    // Pressing Send freezes the message and claims its key: every attempt
    // of this message carries it, so a retry can't send it twice.
    const context = sendContext;
    const idempotencyKey = beginSend(context);
    const draftKey = contextKey;

    if (!onReopen) {
      // No way to bring the composer back: send in place, as before.
      setSending(true);
      sendEmail({ ...payload, idempotencyKey })
        .then(() => {
          finishSend(context, idempotencyKey, "sent");
          dispatchEmailSent({ fromAddress, to, origin: "compose" });
          clearDraft();
          setFiles([]);
          onClose();
        })
        .catch((sendError) => {
          finishSend(context, idempotencyKey, "failed");
          setError(sendKeyProblem(sendError, context) ?? failure);
        })
        .finally(() => setSending(false));
      return;
    }

    // Undo Send: the composer closes at once (its draft is kept by the
    // close-flush), the message waits for the undo window, then goes.
    onClose();
    sendWithUndo({
      seconds: undoSendSeconds,
      label: "Sending…",
      send: () =>
        sendEmail({ ...payload, idempotencyKey }).then(() => undefined),
      onUndo: () => {
        finishSend(context, idempotencyKey, "undone");
        onReopen(snapshot, draftKey);
      },
      onSent: () => {
        finishSend(context, idempotencyKey, "sent");
        dispatchEmailSent({ fromAddress, to, origin: "compose" });
        // The message went out: drop its draft, unless the composer open
        // right now is writing on that same slot (it owns the draft now).
        if (!(openRef.current && contextKeyRef.current === draftKey))
          deleteDraft(draftKey).catch(() => {});
      },
      onError: (sendError) => {
        // The message comes back with the same key, so sending it again
        // cannot send it twice.
        finishSend(context, idempotencyKey, "failed");
        onReopen(
          { ...snapshot, error: sendKeyProblem(sendError, context) ?? failure },
          draftKey,
        );
      },
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  if (!open) return null;

  return (
    // Non-modal tray (Gmail-style): the inbox stays clickable behind the
    // compose window, only the close button or Esc dismisses, and the
    // tray is anchored to the bottom-right.
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(v) => !v && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tray-overlay fixed inset-0 z-50" />
        <DialogPrimitive.Content
          onKeyDown={handleKeyDown}
          onEscapeKeyDown={(e) => {
            if (suggesting) e.preventDefault();
          }}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          className={trayContentClass({ fullscreen, width: "compose" })}
        >
          {/* Slim single-row header — title + max/close. */}
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2.5 pl-4">
            <div className="flex min-w-0 items-center gap-2">
              <PenSquare
                size={15}
                className="shrink-0 text-text-secondary"
                aria-hidden
              />
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                {to ? `New message · ${to}` : "New message"}
              </DialogPrimitive.Title>
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

          {/* Compact metadata: From / To / Cc / Subject. Each field is
              a single inline row with no grid label column — keeps the
              chrome closer to ~150px so the body has more room. */}
          <div
            className="shrink-0 divide-y divide-border-subtle border-b border-border bg-card"
            data-testid="compose-metadata"
          >
            <TrayMetaRow label="From">
              <select
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                required
                className="w-full bg-transparent py-2.5 pr-3 text-sm text-text-primary outline-none"
              >
                {recipients.map((r) => (
                  <option key={r} value={r}>
                    {getFromLabel(r, senderIdentities)}
                  </option>
                ))}
              </select>
            </TrayMetaRow>
            <TrayMetaRow label="To" htmlFor="compose-to">
              <RecipientInput
                id="compose-to"
                value={to}
                onChange={(v) => {
                  setTo(v);
                  if (toPerson && v !== toPerson.email) setToPerson(null);
                }}
                onPick={setToPerson}
                onSuggestionsOpenChange={onSuggestingChange}
                placeholder="recipient@example.com"
                className="w-full bg-transparent py-2.5 pr-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </TrayMetaRow>
            <TrayMetaRow label="Cc">
              <CcInput
                value={cc}
                onChange={setCc}
                internalDomains={internalDomains}
                testId="compose-cc-input"
              />
            </TrayMetaRow>
            <TrayMetaRow label="Subject" htmlFor="compose-subject">
              <input
                id="compose-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                required
                placeholder="What's it about?"
                aria-label="Subject"
                className="w-full bg-transparent py-2.5 pr-3 text-sm text-text-primary outline-none placeholder:text-text-tertiary"
              />
            </TrayMetaRow>
          </div>

          {pendingTemplate && (
            <TemplateVarsBar
              key={pendingTemplate.id}
              template={pendingTemplate}
              recipient={toPerson ?? { email: to, name: null }}
              onCancel={() => setPendingTemplate(null)}
              onApply={(r) => {
                setSubject(r.subject);
                setBodyHtml(r.bodyHtml);
                setPendingTemplate(null);
                // Keep focus in the tray (so ⌘Enter still sends): move it
                // to the message once the editor has the new content.
                window.setTimeout(() => {
                  document
                    .querySelector<HTMLElement>(
                      '[data-testid="compose-body"] .ProseMirror',
                    )
                    ?.focus();
                }, 60);
              }}
            />
          )}

          {/* Body — no min-height, just flex-1 so the editor fills the
              tray. The smooth-scroll wrapper keeps long drafts scrollable. */}
          <div
            className="smooth-scroll flex min-h-0 flex-1 flex-col overflow-y-auto bg-card px-4 py-3 sm:px-5"
            data-testid="compose-body"
          >
            <AttachmentPicker
              enableDragDrop
              buttonClassName="hidden"
              onFilesAdded={(added) => setFiles((prev) => [...prev, ...added])}
            >
              <TiptapEditor
                content={bodyHtml}
                onUpdate={(html, text) => {
                  setBodyHtml(html);
                  setBodyText(text);
                }}
              />
              <AttachmentChips
                files={files}
                capBytes={ATTACHMENT_CAP_BYTES}
                onRemove={(idx) =>
                  setFiles((prev) => prev.filter((_, i) => i !== idx))
                }
              />
              {safeSignatureHtml && (
                <div
                  data-signature
                  data-testid="compose-signature-preview"
                  className="mt-4 border-t border-border-subtle pt-3 text-text-secondary opacity-80"
                  // Read-only signature preview. Auto-attached at send time;
                  // edited via the admin Inboxes page rather than inline.
                  // Pre-sanitized via sanitizeEmailHtml — see safeSignatureHtml.
                  dangerouslySetInnerHTML={{ __html: safeSignatureHtml }}
                />
              )}
            </AttachmentPicker>
          </div>

          <SendingPausedNotice className="border-t border-border bg-card px-4 pt-2 sm:px-5" />
          {/* Slim footer — single row, just send + cancel + hint. */}
          <div
            className="flex shrink-0 items-center justify-between gap-3 border-t border-border bg-card px-4 pt-2.5 sm:px-5"
            style={{
              paddingBottom: "max(0.625rem, env(safe-area-inset-bottom))",
            }}
          >
            <div className="min-w-0 truncate text-xs text-text-tertiary">
              {error ? (
                <span className="text-destructive" role="alert">
                  {error}
                </span>
              ) : (
                <span className="flex items-center gap-3">
                  <span
                    aria-live="polite"
                    className="inline-flex items-center gap-1"
                  >
                    {draftStatus === "saving" && "Saving draft…"}
                    {draftStatus === "saved" && (
                      <>
                        <Check size={12} aria-hidden /> Draft saved
                      </>
                    )}
                    {draftStatus === "error" && (
                      <span className="text-warning">Draft not saved</span>
                    )}
                  </span>
                  <span className="hidden sm:inline">
                    <kbd className="rounded border border-border bg-bg-subtle px-1 font-sans text-[11px]">
                      ⌘
                    </kbd>
                    <kbd className="ml-1 rounded border border-border bg-bg-subtle px-1 font-sans text-[11px]">
                      Enter
                    </kbd>{" "}
                    to send
                  </span>
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <TemplatePicker
                onChoose={(t) => {
                  const replacing = subject.trim() || !bodyIsEmpty;
                  if (
                    replacing &&
                    !window.confirm(
                      "Replace the subject and message with this template?",
                    )
                  )
                    return;
                  setPendingTemplate(t);
                }}
              />
              <AttachmentPicker
                onFilesAdded={(added) =>
                  setFiles((prev) => [...prev, ...added])
                }
                buttonClassName="inline-flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              />
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-9 items-center rounded-lg px-3 text-[13.5px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="compose-send-button"
                onClick={handleSend}
                disabled={
                  sending ||
                  bodyIsEmpty ||
                  !to ||
                  totalAttachmentBytes > ATTACHMENT_CAP_BYTES
                }
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={14} />
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
