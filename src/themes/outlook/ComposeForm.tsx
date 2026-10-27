import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Paperclip, Send, Trash2, X } from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import AttachmentPicker from "@/components/AttachmentPicker";
import AttachmentChips from "@/components/AttachmentChips";
import { deleteDraft, sendEmail, type CcEntry } from "@/lib/api";
import { sendWithUndo } from "@/lib/undo-send";
import { useUndoSendSetting } from "./sendUndo";
import { useDraftAutosave } from "@/lib/use-draft-autosave";
import { dispatchEmailSent } from "@/lib/email-events";
import { getFromLabel } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { cn } from "@/lib/utils";
import type { ComposePrefill } from "@/pages/ComposeModal";
import { internalDomainsOf, useIdentities } from "./useConversation";
import { IconButton } from "./ui";

const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

/**
 * Outlook new-mail form. Desktop: fills the reading pane. Mobile: a
 * full-screen sheet with the Send arrow in the header. Same send path,
 * draft autosave ("compose" context) and signature handling as the shared
 * ComposeModal.
 */
export default function ComposeForm({
  prefill,
  onClose,
  variant,
  initialFiles,
  initialError,
  onReopen,
}: {
  prefill: ComposePrefill | null;
  onClose: () => void;
  variant: "pane" | "mobile";
  /** Content restored after Undo send or a failed send. */
  initialFiles?: File[];
  initialError?: string;
  /** Reopen the composer with content (Undo send / send failure). */
  onReopen: (
    prefill: ComposePrefill,
    extras: { files?: File[]; error?: string },
  ) => void;
}) {
  const [undoSettings] = useUndoSendSetting();
  const { recipients, senderIdentities } = useIdentities();
  const [fromAddress, setFromAddress] = useState("");
  const [to, setTo] = useState(prefill?.to ?? "");
  const [cc, setCc] = useState<CcEntry[]>(prefill?.cc ?? []);
  const [showCc, setShowCc] = useState((prefill?.cc?.length ?? 0) > 0);
  const [subject, setSubject] = useState(prefill?.subject ?? "");
  const [bodyHtml, setBodyHtml] = useState(prefill?.bodyHtml ?? "");
  const [bodyText, setBodyText] = useState("");
  const [files, setFiles] = useState<File[]>(initialFiles ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(initialError ?? "");
  const toRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fromAddress || recipients.length === 0) return;
    const want = prefill?.from;
    setFromAddress(want && recipients.includes(want) ? want : recipients[0]);
  }, [recipients, prefill, fromAddress]);

  useEffect(() => {
    if (!prefill?.to) toRef.current?.focus();
  }, [prefill]);

  const internalDomains = useMemo(
    () => internalDomainsOf(senderIdentities),
    [senderIdentities],
  );
  const signatureHtml = senderIdentities.find(
    (s) => s.email === fromAddress,
  )?.signatureHtml;
  const safeSignatureHtml = useMemo(
    () => (signatureHtml ? sanitizeEmailHtml(signatureHtml) : null),
    [signatureHtml],
  );

  const bodyIsEmpty = !bodyHtml || bodyHtml === "<p></p>";
  const isEmpty = !to.trim() && !subject.trim() && bodyIsEmpty;
  const hasPrefill = !!(
    prefill &&
    (prefill.to || prefill.subject || prefill.bodyHtml || prefill.cc?.length)
  );
  const { clear: clearDraft } = useDraftAutosave({
    contextKey: "compose",
    enabled: true,
    isEmpty,
    restore: !hasPrefill,
    values: { fromAddress, to, cc, subject, bodyHtml, bodyText },
    onRestore: (d) => {
      if (d.toAddress) setTo(d.toAddress);
      if (d.cc?.length) {
        setCc(d.cc);
        setShowCc(true);
      }
      if (d.subject) setSubject(d.subject);
      if (d.bodyHtml) setBodyHtml(d.bodyHtml);
      if (d.bodyText) setBodyText(d.bodyText);
      if (d.fromAddress) setFromAddress(d.fromAddress);
    },
  });

  const total = files.reduce((s, f) => s + f.size, 0);
  const canSend =
    !sending && !!to.trim() && !bodyIsEmpty && total <= ATTACHMENT_CAP_BYTES;

  function send() {
    if (!canSend) {
      if (!to.trim()) setError("Add at least one recipient.");
      else if (bodyIsEmpty) setError("Write a message before sending.");
      return;
    }
    setSending(true);
    const finalBody = safeSignatureHtml
      ? `${bodyHtml}<div data-signature>${safeSignatureHtml}</div>`
      : bodyHtml;
    const snapshot: ComposePrefill = {
      from: fromAddress,
      to: to.trim(),
      cc,
      subject,
      bodyHtml,
    };
    const held = files;
    const payload = {
      to: to.trim(),
      fromAddress,
      ...(cc.length ? { cc } : {}),
      subject,
      bodyHtml: finalBody,
      ...(bodyText.trim() ? { bodyText } : {}),
      ...(held.length ? { files: held.map((file) => ({ file })) } : {}),
    };
    // Close at once; the draft is kept (saved on close) until it really goes.
    onClose();
    sendWithUndo({
      seconds: undoSettings.undoSendSeconds,
      send: async () => {
        await sendEmail(payload);
        dispatchEmailSent({ fromAddress, to: payload.to, origin: "compose" });
      },
      onUndo: () => onReopen(snapshot, { files: held }),
      onSent: () => {
        // Let the close-flush save land first, then drop the draft.
        window.setTimeout(
          () => void deleteDraft("compose").catch(() => {}),
          1500,
        );
      },
      onError: (e) =>
        onReopen(snapshot, {
          files: held,
          error: e instanceof Error ? e.message : "Message not sent",
        }),
    });
  }

  function discard() {
    if (!isEmpty && !window.confirm("Discard this draft?")) return;
    clearDraft();
    onClose();
  }

  const fromPicker = recipients.length > 1 && (
    <label className="ol-field">
      <span className="ol-field-label">From</span>
      <span className="relative flex min-w-0 flex-1 items-center">
        <select
          value={fromAddress}
          onChange={(e) => setFromAddress(e.target.value)}
          className="ol-field-select"
          aria-label="From"
        >
          {recipients.map((r) => (
            <option key={r} value={r}>
              {getFromLabel(r, senderIdentities)}
            </option>
          ))}
        </select>
        <ChevronDown
          size={14}
          className="pointer-events-none absolute right-2 text-text-secondary"
          aria-hidden
        />
      </span>
    </label>
  );

  const fields = (
    <div className="ol-compose-fields">
      {fromPicker}
      <div className="ol-field">
        <label htmlFor="ol-compose-to" className="ol-field-label ol-field-btn">
          To
        </label>
        <input
          id="ol-compose-to"
          ref={toRef}
          type="email"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="ol-field-input"
          autoComplete="email"
        />
        {!showCc && (
          <button
            type="button"
            className="ol-link px-2 text-[13px]"
            onClick={() => setShowCc(true)}
          >
            Cc
          </button>
        )}
      </div>
      {showCc && (
        <div className="ol-field">
          <span className="ol-field-label ol-field-btn">Cc</span>
          <div className="min-w-0 flex-1">
            <CcInput
              value={cc}
              onChange={setCc}
              internalDomains={internalDomains}
              testId="ol-compose-cc"
            />
          </div>
        </div>
      )}
      <div className="ol-field">
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="Add a subject"
          aria-label="Subject"
          className="ol-field-input ol-subject-input"
        />
      </div>
    </div>
  );

  const body = (
    <AttachmentPicker
      enableDragDrop
      buttonClassName="hidden"
      onFilesAdded={(added) => setFiles((p) => [...p, ...added])}
    >
      <div className="ol-compose-editor">
        <TiptapEditor
          content={bodyHtml}
          onUpdate={(html, text) => {
            setBodyHtml(html);
            setBodyText(text);
          }}
          placeholder="Type / to insert files and more"
        />
      </div>
      <AttachmentChips
        files={files}
        capBytes={ATTACHMENT_CAP_BYTES}
        onRemove={(i) => setFiles((p) => p.filter((_, j) => j !== i))}
      />
      {safeSignatureHtml && (
        <div
          data-signature
          className="mx-4 mt-3 border-t border-border pt-3 text-[13px] opacity-70"
          // Pre-sanitized via sanitizeEmailHtml.
          dangerouslySetInnerHTML={{ __html: safeSignatureHtml }}
        />
      )}
    </AttachmentPicker>
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  if (variant === "mobile") {
    return (
      <div
        className="ol-m-sheet"
        role="dialog"
        aria-label="New message"
        onKeyDown={onKeyDown}
      >
        <header className="ol-m-sheet-head">
          <IconButton label="Close" size="lg" onClick={discard}>
            <X size={22} />
          </IconButton>
          <h2 className="flex-1 text-center text-[17px] font-semibold text-text-primary">
            New message
          </h2>
          <AttachmentPicker
            onFilesAdded={(added) => setFiles((p) => [...p, ...added])}
            buttonClassName="ol-icon-btn ol-icon-btn-lg"
            buttonLabel={<Paperclip size={20} />}
          />
          <IconButton
            label={sending ? "Sending" : "Send"}
            size="lg"
            onClick={() => void send()}
            className={cn("text-accent", !canSend && "opacity-50")}
          >
            <Send size={22} />
          </IconButton>
        </header>
        {error && (
          <div role="alert" className="ol-error-bar">
            {error}
          </div>
        )}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {fields}
          {body}
        </div>
      </div>
    );
  }

  return (
    <div className="ol-compose" onKeyDown={onKeyDown}>
      <div className="ol-compose-bar">
        <button
          type="button"
          className="ol-btn-primary"
          onClick={() => void send()}
          disabled={sending}
          data-testid="ol-compose-send"
        >
          <Send size={16} aria-hidden />
          {sending ? "Sending…" : "Send"}
        </button>
        <AttachmentPicker
          onFilesAdded={(added) => setFiles((p) => [...p, ...added])}
          buttonClassName="ol-btn-subtle"
          buttonLabel={
            <>
              <Paperclip size={16} aria-hidden /> Attach
            </>
          }
        />
        <button type="button" className="ol-btn-subtle" onClick={discard}>
          <Trash2 size={16} aria-hidden />
          Discard
        </button>
        <div className="flex-1" />
        <IconButton label="Close" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      {error && (
        <div role="alert" className="ol-error-bar">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {fields}
        {body}
      </div>
    </div>
  );
}
