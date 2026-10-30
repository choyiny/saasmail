import { Button } from "@/components/ui/button";
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

  // On open, prefill the correspondent address. Prefer inbound Reply-To
  // (contact-form pattern) when it differs from the attributed sender;
  // otherwise fall back to fromAddress. A row with neither is fetched in
  // full.
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
    if (email.fromAddress) {
      setToEmail(email.fromAddress);
      return;
    }
    let cancelled = false;
    fetchEmail(email.id)
      .then((full) => {
        if (cancelled) return;
        if (full.replyTo) {
          setToEmail(full.replyTo);
          setPrefilledFromReplyTo(true);
          return;
        }
        if (full.fromAddress) setToEmail(full.fromAddress);
      })
      .catch(() => {
        /* no address to prefill — leave blank */
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--chrome-scrim)] p-4 backdrop-blur-[2px]">
      <div
        role="dialog"
        aria-modal="true"
        className="w-full max-w-md rounded-2xl border border-border-strong bg-card p-6 shadow-overlay"
      >
        <h2 className="mb-1 text-base font-semibold tracking-[-0.01em] text-text-primary">
          Reassign message
        </h2>
        <p className="mb-4 text-[13.5px] text-text-secondary">
          Attribute this message to a different person so replies reach them.
          Currently under{" "}
          <span className="font-medium text-text-primary">{currentSender}</span>
          .
        </p>

        <label className="mb-1.5 block text-[13px] font-medium text-text-primary">
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
          className={`mb-1 ${"w-full rounded-lg border border-border-strong bg-card px-3 py-2 text-sm text-text-primary shadow-card placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"}`}
        />
        {prefilledFromReplyTo && (
          <p className="mb-3 text-[11px] text-text-tertiary">
            Pre-filled from the message's Reply-To.
          </p>
        )}

        <label className="mb-1.5 mt-3 block text-[13px] font-medium text-text-primary">
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
          className="w-full rounded-lg border border-border-strong bg-card px-3 py-2 text-sm text-text-primary shadow-card placeholder:text-text-tertiary focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
        />

        {error && <p className="mt-3 text-xs text-destructive">{error}</p>}

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={submitting || !toEmail.trim()}
          >
            {submitting ? "Reassigning..." : "Reassign"}
          </Button>
        </div>
      </div>
    </div>
  );
}
