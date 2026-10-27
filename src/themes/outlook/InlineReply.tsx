import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Paperclip, Send, Trash2 } from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import CcInput from "@/components/CcInput";
import AttachmentPicker from "@/components/AttachmentPicker";
import AttachmentChips from "@/components/AttachmentChips";
import { deleteDraft, replyToEmail, type CcEntry, type Email } from "@/lib/api";
import { sendWithUndo } from "@/lib/undo-send";
import { useUndoSendSetting } from "./sendUndo";
import { useDraftAutosave } from "@/lib/use-draft-autosave";
import { dispatchEmailSent } from "@/lib/email-events";
import { getFromLabel } from "@/lib/format";
import { sanitizeEmailHtml } from "@/lib/sanitize-html";
import { cn } from "@/lib/utils";
import {
  inboxOfEmail,
  internalDomainsOf,
  useIdentities,
} from "./useConversation";
import { IconButton } from "./ui";
import { X } from "lucide-react";

const ATTACHMENT_CAP_BYTES = 25 * 1024 * 1024;

export type ReplyMode = "reply" | "replyAll";

/** Reply content restored after Undo send or a failed send. */
export interface ReplyInitial {
  fromAddress: string;
  cc: CcEntry[];
  bodyHtml: string;
  bodyText: string;
  files: File[];
  error?: string;
}

export interface ReplyState {
  email: Email;
  mode: ReplyMode;
  initial?: ReplyInitial;
}

/**
 * Reopen a reply after Undo send: the reading pane for that conversation
 * picks it up (opening the conversation first if the user moved on).
 */
let pendingReopen: { itemKey: string; state: ReplyState } | null = null;
export const REPLY_REOPEN_EVENT = "ol:reply-reopen";
export function reopenReply(itemKey: string, state: ReplyState) {
  pendingReopen = { itemKey, state };
  window.dispatchEvent(
    new CustomEvent(REPLY_REOPEN_EVENT, { detail: itemKey }),
  );
}
export function takePendingReopen(itemKey: string): ReplyState | null {
  if (!pendingReopen || pendingReopen.itemKey !== itemKey) return null;
  const s = pendingReopen.state;
  pendingReopen = null;
  return s;
}

/**
 * Outlook's inline reply: a compose card at the top of the reading pane
 * (desktop) or a full-screen sheet (mobile). Sends through the same reply
 * endpoint and draft key (`reply:<emailId>`) as the shared ReplyComposer.
 */
export default function InlineReply({
  email,
  mode,
  counterpart,
  onClose,
  onSent,
  variant = "pane",
  initial,
  itemKey,
}: {
  email: Email;
  mode: ReplyMode;
  initial?: ReplyInitial;
  /** The conversation this reply belongs to (for reopening on Undo). */
  itemKey: string;
  /** Who the reply goes to (person name/email), for the To line. */
  counterpart: string;
  onClose: () => void;
  onSent: () => void;
  variant?: "pane" | "mobile";
}) {
  const { recipients, senderIdentities } = useIdentities();
  const ownInbox = inboxOfEmail(email);
  const fromOptions = useMemo(
    () => (ownInbox ? [ownInbox] : recipients),
    [ownInbox, recipients],
  );
  const [undoSettings] = useUndoSendSetting();
  const [fromAddress, setFromAddress] = useState(
    initial?.fromAddress ?? ownInbox ?? "",
  );
  const [cc, setCc] = useState<CcEntry[]>(initial?.cc ?? []);
  const [bodyHtml, setBodyHtml] = useState(initial?.bodyHtml ?? "");
  const [bodyText, setBodyText] = useState(initial?.bodyText ?? "");
  const [files, setFiles] = useState<File[]>(initial?.files ?? []);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(initial?.error ?? "");
  const restored = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!fromAddress && fromOptions[0]) setFromAddress(fromOptions[0]);
  }, [fromOptions, fromAddress]);

  // Reply all: copy the original Cc minus our own inboxes.
  useEffect(() => {
    if (mode !== "replyAll" || restored.current || initial) return;
    const ours = new Set(recipients.map((r) => r.toLowerCase()));
    setCc((email.cc ?? []).filter((c) => !ours.has(c.email.toLowerCase())));
  }, [mode, email, recipients]);

  useEffect(() => {
    cardRef.current?.scrollIntoView({ block: "nearest" });
    const ed = cardRef.current?.querySelector<HTMLElement>(
      "[contenteditable=true]",
    );
    ed?.focus();
  }, []);

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
  const { clear: clearDraft } = useDraftAutosave({
    contextKey: `reply:${email.id}`,
    enabled: true,
    isEmpty: bodyIsEmpty,
    restore: !initial,
    values: { fromAddress, cc, bodyHtml, bodyText, replyToEmailId: email.id },
    onRestore: (d) => {
      restored.current = true;
      if (d.bodyHtml) setBodyHtml(d.bodyHtml);
      if (d.bodyText) setBodyText(d.bodyText);
      if (d.cc) setCc(d.cc);
      if (d.fromAddress) setFromAddress(d.fromAddress);
    },
  });

  const total = files.reduce((s, f) => s + f.size, 0);

  function send() {
    if (bodyIsEmpty) {
      setError("Write a reply before sending.");
      return;
    }
    if (total > ATTACHMENT_CAP_BYTES) return;
    setSending(true);
    const finalBody = safeSignatureHtml
      ? `${bodyHtml}<div data-signature>${safeSignatureHtml}</div>`
      : bodyHtml;
    const snapshot: ReplyInitial = {
      fromAddress,
      cc,
      bodyHtml,
      bodyText,
      files,
    };
    const emailId = email.id;
    const payload = {
      bodyHtml: finalBody,
      ...(bodyText.trim() ? { bodyText } : {}),
      fromAddress,
      ...(cc.length ? { cc } : {}),
      ...(files.length ? { files: files.map((file) => ({ file })) } : {}),
    };
    // Close at once; the draft is kept (saved on close) until it really goes.
    onClose();
    sendWithUndo({
      seconds: undoSettings.undoSendSeconds,
      label: "Sending reply…",
      send: async () => {
        await replyToEmail(emailId, payload);
        dispatchEmailSent({ fromAddress, to: counterpart, origin: "reply" });
      },
      onUndo: () => reopenReply(itemKey, { email, mode, initial: snapshot }),
      onSent: () => {
        onSent();
        window.setTimeout(
          () => void deleteDraft(`reply:${emailId}`).catch(() => {}),
          1500,
        );
      },
      onError: (e) =>
        reopenReply(itemKey, {
          email,
          mode,
          initial: {
            ...snapshot,
            error: e instanceof Error ? e.message : "Reply not sent",
          },
        }),
    });
  }

  function discard() {
    if (!bodyIsEmpty && !window.confirm("Discard this reply?")) return;
    clearDraft();
    onClose();
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send();
    }
  };

  const fields = (
    <div className="ol-compose-fields">
      {fromOptions.length > 1 && (
        <label className="ol-field">
          <span className="ol-field-label">From</span>
          <span className="relative flex min-w-0 flex-1 items-center">
            <select
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              className="ol-field-select"
              aria-label="From"
            >
              {fromOptions.map((r) => (
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
      )}
      <div className="ol-field">
        <span className="ol-field-label ol-field-btn">To</span>
        <span className="ol-chip">{counterpart}</span>
      </div>
      <div className="ol-field">
        <span className="ol-field-label ol-field-btn">Cc</span>
        <div className="min-w-0 flex-1">
          <CcInput
            value={cc}
            onChange={setCc}
            internalDomains={internalDomains}
            testId="ol-reply-cc"
          />
        </div>
      </div>
    </div>
  );

  const editor = (
    <AttachmentPicker
      enableDragDrop
      buttonClassName="hidden"
      onFilesAdded={(added) => setFiles((p) => [...p, ...added])}
    >
      <div className="ol-compose-editor ol-reply-editor">
        <TiptapEditor
          content={bodyHtml}
          onUpdate={(html, text) => {
            setBodyHtml(html);
            setBodyText(text);
          }}
          placeholder="Write your reply"
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
          dangerouslySetInnerHTML={{ __html: safeSignatureHtml }}
        />
      )}
    </AttachmentPicker>
  );

  if (variant === "mobile") {
    return (
      <div
        className="ol-m-sheet"
        role="dialog"
        aria-label={mode === "replyAll" ? "Reply all" : "Reply"}
        onKeyDown={onKeyDown}
      >
        <header className="ol-m-sheet-head">
          <IconButton label="Discard" size="lg" onClick={discard}>
            <X size={22} />
          </IconButton>
          <h2 className="flex-1 truncate text-center text-[17px] font-semibold text-text-primary">
            {mode === "replyAll" ? "Reply all" : "Reply"}
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
            className={cn(
              "text-accent",
              (bodyIsEmpty || sending) && "opacity-50",
            )}
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
          {editor}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={cardRef}
      className="ol-reply-card"
      onKeyDown={onKeyDown}
      data-testid="ol-inline-reply"
    >
      {fields}
      {editor}
      {error && (
        <div role="alert" className="ol-error-bar">
          {error}
        </div>
      )}
      <div className="ol-compose-bar ol-compose-bar-bottom">
        <button
          type="button"
          className="ol-btn-primary"
          onClick={() => void send()}
          disabled={sending}
          data-testid="ol-reply-send"
        >
          <Send size={16} aria-hidden />
          {sending ? "Sending…" : "Send"}
        </button>
        <button type="button" className="ol-btn-subtle" onClick={discard}>
          <Trash2 size={16} aria-hidden />
          Discard
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
      </div>
    </div>
  );
}
