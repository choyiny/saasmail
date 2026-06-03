import { useState, useEffect } from "react";
import {
  fetchEmail,
  reassignEmailPerson,
  type Email,
  type ReassignPersonResult,
} from "@/lib/api";

interface ReassignPersonModalProps {
  /** The received email being re-associated, or null when closed. */
  email: Email | null;
  /** Current sender label shown for context (the person it's threaded under). */
  currentSender: string;
  open: boolean;
  onClose: () => void;
  onDone: (result: ReassignPersonResult) => void;
}

export default function ReassignPersonModal({
  email,
  currentSender,
  open,
  onClose,
  onDone,
}: ReassignPersonModalProps) {
  const [toEmail, setToEmail] = useState("");
  const [name, setName] = useState("");
  const [prefilledFromReplyTo, setPrefilledFromReplyTo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On open, prefill the address from the message's inbound Reply-To when
  // present. The thread list doesn't carry replyTo, so fetch the single
  // email (which surfaces it) unless the object already has it.
  useEffect(() => {
    if (!open || !email) return;
    setName("");
    setError(null);
    setToEmail("");
    setPrefilledFromReplyTo(false);

    if (email.replyTo) {
      setToEmail(email.replyTo);
      setPrefilledFromReplyTo(true);
      return;
    }
    let cancelled = false;
    fetchEmail(email.id)
      .then((full) => {
        if (cancelled || !full.replyTo) return;
        setToEmail(full.replyTo);
        setPrefilledFromReplyTo(true);
      })
      .catch(() => {
        /* no Reply-To to prefill — leave blank */
      });
    return () => {
      cancelled = true;
    };
  }, [open, email]);

  if (!open || !email) return null;

  async function handleSubmit() {
    if (!email) return;
    const trimmed = toEmail.trim();
    if (!trimmed) {
      setError("Enter an email address.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await reassignEmailPerson(email.id, {
        email: trimmed,
        name: name.trim() || null,
      });
      onDone(result);
      onClose();
    } catch {
      setError("Couldn't reassign this message. Check the address and retry.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-md rounded-xl border border-border bg-white ring-1 ring-gray-200 p-6">
        <h2 className="mb-1 text-lg font-semibold text-text-primary">
          Reassign message
        </h2>
        <p className="mb-4 text-sm text-text-secondary">
          Move this message to a different person — replies will go to them.
          Currently from{" "}
          <span className="font-medium text-text-primary">{currentSender}</span>
          .
        </p>

        <label className="mb-1 block text-xs font-medium text-text-secondary">
          Person's email
        </label>
        <input
          type="email"
          autoFocus
          value={toEmail}
          onChange={(e) => {
            setToEmail(e.target.value);
            setPrefilledFromReplyTo(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          placeholder="real.person@example.com"
          className="mb-1 w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 py-2 text-sm text-text-primary"
        />
        {prefilledFromReplyTo && (
          <p className="mb-3 text-[11px] text-text-tertiary">
            Pre-filled from the message's Reply-To.
          </p>
        )}

        <label className="mb-1 mt-3 block text-xs font-medium text-text-secondary">
          Name <span className="text-text-tertiary">(optional)</span>
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleSubmit();
          }}
          placeholder="Jane Doe"
          className="w-full rounded-md border border-border bg-white ring-1 ring-gray-200 px-3 py-2 text-sm text-text-primary"
        />

        {error && <p className="mt-3 text-xs text-red-400">{error}</p>}

        <div className="mt-5 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary hover:bg-bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting || !toEmail.trim()}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent/90 disabled:opacity-50"
          >
            {submitting ? "Reassigning..." : "Reassign"}
          </button>
        </div>
      </div>
    </div>
  );
}
