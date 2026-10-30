import {
  beginSend,
  finishSend,
  forgetSendKey,
  sendKeyProblem,
} from "@/lib/send-key";
import { useState, useEffect, useMemo, useRef } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  X,
  Send,
  Reply as ReplyIcon,
  FileText,
  Sparkles,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import ThreadMessage from "@/components/ThreadMessage";
import AttachmentPicker from "@/components/AttachmentPicker";
import SendingPausedNotice from "@/components/SendingPausedNotice";
import AttachmentChips from "@/components/AttachmentChips";
import ReplyToHint from "@/components/ReplyToHint";
import {
  TrayMaximizeButton,
  TrayMetaRow,
  trayContentClass,
} from "@/components/Tray";
import {
  replyToEmail,
  fetchTemplates,
  fetchEmail,
  fetchPersonEmails,
  type EmailTemplate,
  type Email,
  type CcEntry,
} from "@/lib/api";
import { dispatchEmailSent } from "@/lib/email-events";
import { sendWithUndo } from "@/lib/undo-send";
import { useCommonSettings } from "@/lib/default-layout-settings";
import { showToast } from "@/lib/toast";
import { serverErrorMessage } from "@/lib/error-message";
import { useDraftAutosave } from "@/lib/use-draft-autosave";
import { getFromLabel } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { analyzeTemplateClient, chipLabel } from "@/lib/template-syntax";
import { cn } from "@/lib/utils";

const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

interface ReplyComposerProps {
  emailId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
  senderIdentities: Array<{
    email: string;
    displayName: string | null;
    signatureHtml?: string | null;
  }>;
  /** Domains we treat as "internal" — used for CC chip color. */
  internalDomains?: string[];
  onClose: () => void;
  onSent: () => void;
  /**
   * Pre-fill CC from the original message ("Reply all"). Defaults to true,
   * which is the long-standing behaviour; pass false for a plain Reply.
   */
  replyAll?: boolean;
}

type Tab = "freeform" | "template";

export default function ReplyComposer({
  emailId,
  personName,
  personEmail,
  recipients,
  senderIdentities,
  internalDomains = [],
  onClose,
  onSent,
  replyAll = true,
}: ReplyComposerProps) {
  const [tab, setTab] = useState<Tab>("freeform");
  const [fromAddress, setFromAddress] = useState(recipients[0] ?? "");
  const [cc, setCc] = useState<CcEntry[]>([]);
  const [bodyHtml, setBodyHtml] = useState("");
  // Plain-text mirror of the editor, kept in lockstep with bodyHtml so the
  // reply ships a `text/plain` part and renders as a normal chat bubble.
  const [bodyText, setBodyText] = useState("");
  // Stored separately from the body so swapping `From` mid-reply replaces
  // the trailing signature without touching what the user has typed.
  const [signatureHtml, setSignatureHtml] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const totalAttachmentBytes = files.reduce((s, f) => s + f.size, 0);
  // Compact tray vs. full-viewport. Toggled by the maximize button.
  const [fullscreen, setFullscreen] = useState(false);
  // Undo Send: while a send is held (or in flight) the tray is hidden but
  // stays mounted, so Undo or a failure brings it back exactly as it was.
  const [held, setHeld] = useState(false);
  const [undoneOnce, setUndoneOnce] = useState(false);
  const [{ undoSendSeconds }] = useCommonSettings();
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Set once a saved reply draft has been restored, so the reply-all CC
  // default below yields to the draft's own CC regardless of which async
  // load resolves first.
  const draftRestoredRef = useRef(false);

  // Autosave the freeform reply so a half-written reply survives closing the
  // composer, keyed to the email being replied to.
  const bodyIsEmpty = !bodyHtml || bodyHtml === "<p></p>";
  const { clear: clearDraft } = useDraftAutosave({
    contextKey: `reply:${emailId}`,
    // Hiding the tray for Undo Send flushes the draft to the server, so it
    // survives until the send really goes out.
    enabled: !held,
    isEmpty: bodyIsEmpty,
    // After an Undo the tray already holds the content; don't let an older
    // copy of the draft overwrite it.
    restore: !undoneOnce,
    values: { fromAddress, cc, bodyHtml, bodyText, replyToEmailId: emailId },
    onRestore: (draft) => {
      draftRestoredRef.current = true;
      if (draft.bodyHtml) setBodyHtml(draft.bodyHtml);
      if (draft.bodyText) setBodyText(draft.bodyText);
      if (draft.cc) setCc(draft.cc);
      if (draft.fromAddress) setFromAddress(draft.fromAddress);
    },
  });

  // Sync the signature trail to the active From inbox.
  useEffect(() => {
    if (!fromAddress) {
      setSignatureHtml(null);
      return;
    }
    const match = senderIdentities.find((s) => s.email === fromAddress);
    setSignatureHtml(match?.signatureHtml ?? null);
  }, [fromAddress, senderIdentities]);

  // Sanitize the signature once per change. Server sanitizes on write
  // too; this is defense-in-depth for the browser render path
  // (dangerouslySetInnerHTML) and for the outbound body we POST.
  const safeSignatureHtml = useMemo(
    () => (signatureHtml ? sanitizeEmailHtml(signatureHtml) : null),
    [signatureHtml],
  );

  // Thread context — the email being replied to + prior messages from the
  // same person/inbox so the user can reference them while drafting.
  const [originalEmail, setOriginalEmail] = useState<Email | null>(null);
  const [threadEmails, setThreadEmails] = useState<Email[]>([]);
  const [threadExpanded, setThreadExpanded] = useState(false);
  // Surface failure to load the original. The previous silent `.catch`
  // masked a real bug — the server didn't look up sent_emails, so
  // clicking Reply on our own outgoing message rendered an empty
  // composer with no warning.
  const [contextError, setContextError] = useState(false);
  // The message asked for replies at other addresses (Reply-To): the first
  // becomes To and the rest are copied, unless the user ticks "Reply to the
  // sender instead". Known only once the original has loaded.
  const replyRecipients =
    originalEmail?.type === "received"
      ? (originalEmail.replyRecipients ?? [])
      : [];
  const [replyToSender, setReplyToSender] = useState(false);
  const followsReplyTo = replyRecipients.length > 0 && !replyToSender;
  // Always say which target was on screen. Left to its default the server
  // follows Reply-To, which this composer may never have shown (the original
  // can fail to load, or the user can send before it has).
  const recipientPayload = {
    recipient: followsReplyTo ? ("reply_to" as const) : ("sender" as const),
  };

  // Template state
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");

  // Load the email being replied to + the surrounding thread on mount.
  // Pre-populate CC from the original message so "reply-all" semantics
  // are the default — users can still trim chips before sending.
  useEffect(() => {
    let cancelled = false;
    setContextError(false);
    fetchEmail(emailId)
      .then(async (email) => {
        if (cancelled) return;
        setOriginalEmail(email);
        if (
          replyAll &&
          email.cc &&
          email.cc.length > 0 &&
          !draftRestoredRef.current
        ) {
          // Drop our own inbox addresses from the suggested CC list — we
          // don't want to CC ourselves on a reply we're sending.
          const ours = new Set(recipients.map((r) => r.toLowerCase()));
          setCc(email.cc.filter((c) => !ours.has(c.email.toLowerCase())));
        }
        // If we have a personId, fetch the person's recent emails in this inbox.
        if (email.personId) {
          try {
            const recipient = email.recipient ?? email.fromAddress ?? undefined;
            const res = await fetchPersonEmails(email.personId, {
              recipient,
              limit: 12,
            });
            if (!cancelled) setThreadEmails(res.emails);
          } catch (err) {
            // Surface to console so a future regression isn't invisible.
            console.warn("Failed to load surrounding thread", err);
          }
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // The composer still works — the user can type and send. But
        // they'd have no idea why the "what you're replying to" panel
        // is missing without this notice.
        console.warn("Failed to load reply context", err);
        setContextError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [emailId, recipients]);

  const selectedTemplate =
    templates.find((t) => t.slug === selectedSlug) ?? null;

  // Only top-level names, same contract the send API validates — names
  // scoped inside a {{#section}} resolve per item, not from this form, so
  // they're deliberately excluded (see src/lib/template-syntax.ts).
  const templateAnalysis = useMemo(() => {
    if (!selectedTemplate) return null;
    try {
      return analyzeTemplateClient(
        selectedTemplate.subject,
        selectedTemplate.bodyHtml,
      );
    } catch {
      // A stored template shouldn't fail to parse, but if one somehow does,
      // fall back to no prompts rather than crashing the composer.
      return null;
    }
  }, [selectedTemplate]);
  const requiredVars = templateAnalysis?.required ?? [];
  // A required name that's actually a section (e.g. {{#items}}) needs an
  // array of objects, not the plain string this form's inputs collect — used
  // below to warn that such a template can't be filled in from here. The
  // chip text itself comes from the shared `chipLabel`.
  const sectionVarNames = useMemo(
    () => new Set((templateAnalysis?.sections ?? []).map((s) => s.name)),
    [templateAnalysis],
  );

  useEffect(() => {
    if (!selectedTemplate) return;
    const vars: Record<string, string> = {};
    for (const v of requiredVars) {
      if (v.toLowerCase() === "name" && personName) vars[v] = personName;
      else if (v.toLowerCase() === "email") vars[v] = personEmail;
      else vars[v] = templateVars[v] ?? "";
    }
    setTemplateVars(vars);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlug, requiredVars.join(",")]);

  useEffect(() => {
    if (tab !== "template" || templates.length > 0) return;
    setTemplatesLoading(true);
    setTemplatesError("");
    fetchTemplates()
      .then(setTemplates)
      .catch(() => setTemplatesError("Failed to load templates"))
      .finally(() => setTemplatesLoading(false));
  }, [tab, templates.length]);

  // One key per reply: every attempt sends it; sending it or closing the
  // composer forgets it. (A reload closes nothing, so a retry keeps it.) A
  // send held for Undo or in flight keeps its key even if the composer
  // closes: only its own success or Undo forgets it.
  const sendContext = `send:reply:${emailId}`;
  useEffect(() => () => forgetSendKey(sendContext), [sendContext]);

  function handleSend() {
    if (sending || held) return;
    if (tab === "template" && !selectedSlug) {
      setError("Select a template");
      return;
    }
    setError("");
    const ccPayload = cc.length > 0 ? cc : undefined;
    const filesPayload =
      files.length > 0 ? { files: files.map((file) => ({ file })) } : {};
    // Wrap the signature in a marker div so the chat-feed "hide
    // signatures" toggle can strip it cleanly. Skip when the inbox has
    // none configured. Templates already include their own boilerplate
    // so we don't append.
    const payload =
      tab === "freeform"
        ? {
            bodyHtml: safeSignatureHtml
              ? `${bodyHtml}<div data-signature>${safeSignatureHtml}</div>`
              : bodyHtml,
            ...(bodyText.trim() ? { bodyText } : {}),
            fromAddress,
            ...(ccPayload ? { cc: ccPayload } : {}),
            ...filesPayload,
            ...recipientPayload,
          }
        : {
            templateSlug: selectedSlug,
            variables: templateVars,
            fromAddress,
            ...(ccPayload ? { cc: ccPayload } : {}),
            ...filesPayload,
            ...recipientPayload,
          };
    const from = fromAddress;
    // Pressing Send freezes the reply and claims its key.
    const context = sendContext;
    const idempotencyKey = beginSend(context);

    setHeld(true);
    setSending(true);
    sendWithUndo({
      seconds: undoSendSeconds,
      label: "Sending reply…",
      send: () =>
        replyToEmail(emailId, { ...payload, idempotencyKey }).then(
          () => undefined,
        ),
      onUndo: () => {
        finishSend(context, idempotencyKey, "undone");
        if (mountedRef.current) {
          setUndoneOnce(true);
          setSending(false);
          setHeld(false);
        } else {
          // The conversation was closed meanwhile; the draft is saved.
          showToast({
            kind: "info",
            message: "Reply not sent",
            description:
              "It's saved as a draft. Open Reply on the message to finish it.",
          });
        }
      },
      onSent: () => {
        finishSend(context, idempotencyKey, "sent");
        // The reply went out — discard its draft so it doesn't reappear.
        clearDraft();
        // Notify the rest of the app — PersonDetail uses this to
        // auto-switch the active inbox tab when the user replied from a
        // different inbox than the one they were viewing.
        dispatchEmailSent({
          fromAddress: from,
          to: personEmail,
          origin: "reply",
        });
        if (!mountedRef.current) return;
        setFiles([]);
        setSending(false);
        onSent();
        onClose();
      },
      onError: (e) => {
        // The reply stays in the composer with the same key, so sending it
        // again cannot send it twice.
        finishSend(context, idempotencyKey, "failed");
        const keyProblem = sendKeyProblem(e, context);
        if (!mountedRef.current) return;
        setSending(false);
        setHeld(false);
        // The server's own words when it has any: a Gmail reply it refused
        // was *not* queued, so the user has to send it again — a generic
        // "failed" would leave them waiting for a retry that isn't coming.
        setError(keyProblem ?? serverErrorMessage(e) ?? "Failed to send reply");
      },
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSend();
    }
  }

  const recipientLabel = personName
    ? `${personName} <${personEmail}>`
    : personEmail;
  // A reply to one of our own sent messages goes to that message's recipient,
  // which is not always this timeline's person: it may have followed a
  // Reply-To.
  const sentTo =
    originalEmail?.type === "sent" ? originalEmail.toAddress : null;
  const toLabel = followsReplyTo
    ? replyRecipients[0].email
    : sentTo && sentTo.toLowerCase() !== personEmail.toLowerCase()
      ? sentTo
      : recipientLabel;

  // Held for Undo Send: hidden, but kept mounted with all its content.
  if (held) return null;

  return (
    // Non-modal tray (Gmail-style): page behind stays interactive, only
    // X / Esc closes. Same shape as ComposeModal so the two feel like
    // one component family.
    <DialogPrimitive.Root
      open
      modal={false}
      onOpenChange={(v) => !v && onClose()}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="tray-overlay fixed inset-0 z-50" />
        <DialogPrimitive.Content
          onKeyDown={handleKeyDown}
          onInteractOutside={(e) => e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          data-testid="reply-composer"
          className={trayContentClass({ fullscreen, width: "compose" })}
        >
          {/* Slim single-row header. */}
          <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border bg-card px-2.5 pl-4">
            <div className="flex min-w-0 items-center gap-2">
              <ReplyIcon
                size={15}
                className="shrink-0 text-text-secondary"
                aria-hidden
              />
              <DialogPrimitive.Title className="truncate text-sm font-semibold text-text-primary">
                Reply · {recipientLabel}
              </DialogPrimitive.Title>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <ModePillToggle tab={tab} onTab={setTab} />
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

          {/* Compact metadata: From / To / Cc. */}
          <div className="shrink-0 divide-y divide-border-subtle border-b border-border bg-card">
            <TrayMetaRow label="From">
              <select
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                className="w-full bg-transparent py-2.5 pr-3 text-sm text-text-primary outline-none"
              >
                {recipients.map((r) => (
                  <option key={r} value={r}>
                    {getFromLabel(r, senderIdentities)}
                  </option>
                ))}
              </select>
            </TrayMetaRow>
            <TrayMetaRow label="To">
              <span
                data-testid="reply-to-address"
                className="block truncate py-2.5 pr-3 text-sm text-text-primary"
              >
                {toLabel}
              </span>
            </TrayMetaRow>
            {replyRecipients.length > 0 && (
              <ReplyToHint
                recipients={replyRecipients}
                toSender={replyToSender}
                onToggle={setReplyToSender}
                className="px-4 py-2 sm:px-5"
              />
            )}
            <TrayMetaRow label="Cc">
              <CcInput
                value={cc}
                onChange={setCc}
                internalDomains={internalDomains}
                testId="reply-cc-input"
              />
            </TrayMetaRow>
          </div>

          {/* Body — flex-1, no min-height pin. */}
          <div className="smooth-scroll flex min-h-0 flex-1 flex-col overflow-y-auto bg-card">
            {tab === "freeform" ? (
              <div className="flex flex-1 flex-col gap-3 px-4 py-3 sm:px-5">
                {/* Thread context — what you're replying to */}
                {originalEmail && (
                  <ThreadContext
                    original={originalEmail}
                    thread={threadEmails}
                    expanded={threadExpanded}
                    onToggle={() => setThreadExpanded((v) => !v)}
                  />
                )}
                {!originalEmail && contextError && (
                  <div
                    role="status"
                    className="rounded-xl border border-warning-border bg-warning-bg px-4 py-2.5 text-[13px] text-warning"
                  >
                    Couldn't load the original message — it may have been
                    deleted. You can still send your reply.
                  </div>
                )}
                <div className="flex-1">
                  <AttachmentPicker
                    enableDragDrop
                    buttonClassName="hidden"
                    onFilesAdded={(added) =>
                      setFiles((prev) => [...prev, ...added])
                    }
                  >
                    <TiptapEditor
                      content={bodyHtml}
                      onUpdate={(html, text) => {
                        setBodyHtml(html);
                        setBodyText(text);
                      }}
                      placeholder="Write your reply…"
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
                        data-testid="reply-signature-preview"
                        className="mt-4 border-t border-border-subtle pt-3 text-text-secondary opacity-80"
                        // Pre-sanitized via sanitizeEmailHtml above.
                        dangerouslySetInnerHTML={{ __html: safeSignatureHtml }}
                      />
                    )}
                  </AttachmentPicker>
                </div>
              </div>
            ) : (
              <div className="space-y-4 px-4 py-3 sm:px-5">
                {templatesLoading ? (
                  <p className="text-sm text-text-tertiary">
                    Loading templates…
                  </p>
                ) : templatesError ? (
                  <p className="text-sm text-destructive">{templatesError}</p>
                ) : (
                  <>
                    <div>
                      <label className="font-label mb-1.5 block text-text-tertiary">
                        Template
                      </label>
                      <select
                        value={selectedSlug}
                        onChange={(e) => setSelectedSlug(e.target.value)}
                        className="h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
                      >
                        <option value="">Select a template…</option>
                        {templates.map((t) => (
                          <option key={t.slug} value={t.slug}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    {selectedTemplate && (
                      <>
                        <div className="rounded-xl border border-border bg-bg-subtle p-4">
                          <p className="font-label mb-1 text-text-tertiary">
                            Subject
                          </p>
                          <p className="text-sm font-medium text-text-primary">
                            {selectedTemplate.subject}
                          </p>
                          <div className="mt-3 border-t border-border pt-3">
                            <p className="font-label mb-1 text-text-tertiary">
                              Body preview
                            </p>
                            <div
                              className="email-surface max-h-48 max-w-none overflow-auto rounded-lg px-3 py-2 text-sm"
                              dangerouslySetInnerHTML={{
                                __html: selectedTemplate.bodyHtml,
                              }}
                            />
                          </div>
                        </div>

                        {requiredVars.length > 0 && (
                          <div>
                            <p className="font-label mb-2 text-text-tertiary">
                              Variables
                            </p>
                            <div className="space-y-2">
                              {requiredVars.map((v) => (
                                <div
                                  key={v}
                                  className="grid grid-cols-[120px_1fr] items-center gap-3"
                                >
                                  <label className="font-code truncate text-xs text-text-secondary">
                                    {templateAnalysis
                                      ? chipLabel(v, templateAnalysis)
                                      : `{{${v}}}`}
                                  </label>
                                  <input
                                    value={templateVars[v] ?? ""}
                                    onChange={(e) =>
                                      setTemplateVars((prev) => ({
                                        ...prev,
                                        [v]: e.target.value,
                                      }))
                                    }
                                    className="h-8 rounded-lg border border-border-strong bg-card px-2.5 text-sm text-text-primary shadow-card outline-none focus:border-accent focus:ring-3 focus:ring-accent/15"
                                  />
                                </div>
                              ))}
                            </div>
                            {[...sectionVarNames].some((n) =>
                              requiredVars.includes(n),
                            ) && (
                              <p className="mt-2 text-xs text-text-tertiary">
                                Section variables (#) need an array of objects —
                                this form can only send plain text, so send
                                those via the API instead.
                              </p>
                            )}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          <SendingPausedNotice className="border-t border-border bg-card px-4 pt-2 sm:px-5" />
          {/* Slim footer — single row, send + cancel + hint. */}
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
                <span className="hidden sm:inline">
                  <kbd className="rounded border border-border bg-bg-subtle px-1 font-sans text-[11px]">
                    ⌘
                  </kbd>
                  <kbd className="ml-1 rounded border border-border bg-bg-subtle px-1 font-sans text-[11px]">
                    Enter
                  </kbd>{" "}
                  to send
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
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
                onClick={handleSend}
                data-testid="reply-send-button"
                disabled={
                  sending || totalAttachmentBytes > ATTACHMENT_CAP_BYTES
                }
                className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-[13.5px] font-medium text-accent-foreground shadow-card transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Send size={14} />
                {sending ? "Sending…" : "Send reply"}
              </button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/**
 * Compact Freeform/Template toggle that lives in the slim header
 * instead of taking its own row. Mirrors the pill-toggle aesthetic
 * used by the Templates editor's view switch.
 */
function ModePillToggle({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <div className="pt-seg mr-1 !p-0.5">
      <ModePill
        active={tab === "freeform"}
        onClick={() => onTab("freeform")}
        icon={Sparkles}
        label="Freeform"
      />
      <ModePill
        active={tab === "template"}
        onClick={() => onTab("template")}
        icon={FileText}
        label="Template"
      />
    </div>
  );
}

function ModePill({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("!h-7 !px-2 !text-xs", active && "on")}
      aria-pressed={active}
    >
      <Icon size={13} />
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}

interface ThreadContextProps {
  original: Email;
  thread: Email[];
  expanded: boolean;
  onToggle: () => void;
}

/**
 * Renders the email being replied to with a collapsible older thread above
 * it. Lets the user reference the conversation while drafting without
 * leaving the composer.
 */
function ThreadContext({
  original,
  thread,
  expanded,
  onToggle,
}: ThreadContextProps) {
  // Older messages (everything except the original), oldest → newest.
  const olderEmails = useMemo(() => {
    const others = thread.filter((e) => e.id !== original.id);
    return [...others].sort((a, b) => a.timestamp - b.timestamp);
  }, [thread, original.id]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-subtle">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2">
          <ReplyIcon size={13} className="shrink-0 text-text-tertiary" />
          <span className="font-label text-text-tertiary">Replying to</span>
          {original.subject && (
            <span className="truncate text-[13px] font-medium text-text-secondary">
              · {original.subject}
            </span>
          )}
        </div>
        {olderEmails.length > 0 && (
          <button
            type="button"
            onClick={onToggle}
            className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary"
          >
            {expanded ? (
              <>
                <ChevronUp size={12} />
                Hide history
              </>
            ) : (
              <>
                <ChevronDown size={12} />
                Show {olderEmails.length} earlier
              </>
            )}
          </button>
        )}
      </div>

      <div className="max-h-[360px] overflow-y-auto smooth-scroll">
        {expanded && olderEmails.length > 0 && (
          <div className="divide-y divide-border-subtle">
            {olderEmails.map((e) => (
              <ThreadMessage key={e.id} email={e} muted />
            ))}
          </div>
        )}
        <div className={olderEmails.length > 0 ? "border-t border-border" : ""}>
          <ThreadMessage email={original} highlight />
        </div>
      </div>
    </div>
  );
}
