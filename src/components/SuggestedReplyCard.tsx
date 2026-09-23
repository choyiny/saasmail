import { useCallback, useEffect, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  dismissSuggestedReply,
  fetchDraft,
  fetchSuggestedReply,
  saveDraft,
  useSuggestedReply,
  type Draft,
  type SuggestedReply,
} from "@/lib/api";
import { onSuggestedReplyReady } from "@/lib/suggested-reply-events";
import { showToast } from "@/lib/toast";

interface SuggestedReplyCardProps {
  emailId: string;
  onUse: () => void;
}

function hasMeaningfulDraft(draft: Draft | null): boolean {
  if (!draft) return false;
  if (draft.bodyText?.trim()) return true;
  if (!draft.bodyHtml) return false;
  const text =
    new DOMParser().parseFromString(draft.bodyHtml, "text/html").body
      .textContent ?? "";
  return text.trim().length > 0;
}

function plainTextToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("");
}

export default function SuggestedReplyCard({
  emailId,
  onUse,
}: SuggestedReplyCardProps) {
  const [suggestion, setSuggestion] = useState<SuggestedReply | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    fetchSuggestedReply(emailId)
      .then(setSuggestion)
      .catch(() => setSuggestion(null));
  }, [emailId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(
    () =>
      onSuggestedReplyReady((event) => {
        if (event.emailId === emailId) refresh();
      }),
    [emailId, refresh],
  );

  if (!suggestion) return null;

  async function handleUse() {
    setBusy(true);
    try {
      const contextKey = `reply:${emailId}`;
      const existing = await fetchDraft(contextKey);
      if (
        hasMeaningfulDraft(existing) &&
        !window.confirm(
          "Replace your existing reply draft with this suggested reply?",
        )
      ) {
        return;
      }

      await saveDraft({
        contextKey,
        ...(existing?.fromAddress ? { fromAddress: existing.fromAddress } : {}),
        ...(existing?.toAddress ? { to: existing.toAddress } : {}),
        ...(existing?.cc ? { cc: existing.cc } : {}),
        ...(existing?.subject ? { subject: existing.subject } : {}),
        bodyHtml: plainTextToHtml(suggestion.bodyText),
        bodyText: suggestion.bodyText,
        replyToEmailId: emailId,
      });
      await useSuggestedReply(suggestion.id);
      setSuggestion(null);
      onUse();
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t use suggested reply",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleDismiss() {
    setBusy(true);
    try {
      await dismissSuggestedReply(suggestion.id);
      setSuggestion(null);
    } catch (error) {
      showToast({
        kind: "error",
        message: "Couldn’t dismiss suggested reply",
        description: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside
      data-testid="suggested-reply-card"
      className="rounded-[8px] border border-violet/20 bg-violet/5 p-3"
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-text-primary">
        <Sparkles size={13} style={{ color: "#7c5cfc" }} aria-hidden />
        Suggested reply
      </div>
      <p
        data-testid="suggested-reply-text"
        className="whitespace-pre-wrap text-sm leading-6 text-text-secondary"
      >
        {suggestion.bodyText}
      </p>
      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          data-testid="suggested-reply-use"
          disabled={busy}
          onClick={() => void handleUse()}
          className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
        >
          Use
        </button>
        <button
          type="button"
          data-testid="suggested-reply-dismiss"
          disabled={busy}
          onClick={() => void handleDismiss()}
          className="rounded-[6px] px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted disabled:opacity-50"
        >
          Dismiss
        </button>
      </div>
    </aside>
  );
}
