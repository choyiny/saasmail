import { useEffect, useRef } from "react";
import {
  fetchDraft,
  saveDraft,
  deleteDraft,
  type Draft,
  type CcEntry,
} from "@/lib/api";

export interface DraftValues {
  fromAddress?: string;
  to?: string;
  cc?: CcEntry[];
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  replyToEmailId?: string | null;
}

interface UseDraftAutosaveOptions {
  /** Identity of the compose surface: "compose" or `reply:<emailId>`. */
  contextKey: string;
  /** True while the composer is open. Autosave only runs when enabled. */
  enabled: boolean;
  /** Current field values, mirrored on every render. */
  values: DraftValues;
  /**
   * Whether the draft has meaningful content. When false, autosave skips
   * saving and removes any previously saved draft (implicit discard).
   */
  isEmpty: boolean;
  /**
   * Hydrate the composer from a saved draft found on open. Called at most
   * once per open. Skipped entirely when `restore` is false.
   */
  onRestore: (draft: Draft) => void;
  /**
   * Whether to restore a saved draft on open. Callers pass false when the
   * composer opens with an explicit prefill that should win.
   */
  restore: boolean;
  /** Debounce before writing, in ms. */
  debounceMs?: number;
}

/**
 * Autosaves a compose/reply draft to the server, debounced, and restores it
 * when the composer reopens. "Restore on reopen": closing keeps the draft
 * (a final flush runs on close); sending or clearing all fields removes it.
 */
export function useDraftAutosave({
  contextKey,
  enabled,
  values,
  isEmpty,
  onRestore,
  restore,
  debounceMs = 1500,
}: UseDraftAutosaveOptions) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest render values/flags, read inside async + cleanup callbacks so they
  // never operate on stale closure state.
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const isEmptyRef = useRef(isEmpty);
  isEmptyRef.current = isEmpty;
  const onRestoreRef = useRef(onRestore);
  onRestoreRef.current = onRestore;
  // Whether a row currently exists on the server for this surface.
  const savedRef = useRef(false);
  // Set by clear() (on send) so the close-flush doesn't re-create the draft.
  const clearedRef = useRef(false);

  // Open: optionally restore, and reset the per-open flags.
  useEffect(() => {
    if (!enabled) return;
    clearedRef.current = false;
    savedRef.current = false;
    let cancelled = false;
    if (restore) {
      fetchDraft(contextKey)
        .then((draft) => {
          if (cancelled || !draft) return;
          savedRef.current = true;
          onRestoreRef.current(draft);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contextKey, restore]);

  // Debounced autosave whenever the fields change.
  useEffect(() => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (clearedRef.current) return;
      if (isEmptyRef.current) {
        // Nothing meaningful left — drop any draft we'd previously saved.
        if (savedRef.current) {
          savedRef.current = false;
          deleteDraft(contextKey).catch(() => {});
        }
        return;
      }
      savedRef.current = true;
      saveDraft({ contextKey, ...valuesRef.current }).catch(() => {});
    }, debounceMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    enabled,
    isEmpty,
    contextKey,
    values.fromAddress,
    values.to,
    JSON.stringify(values.cc),
    values.subject,
    values.bodyHtml,
    values.bodyText,
    values.replyToEmailId,
  ]);

  // Close (enabled → false) or surface change: flush the latest state so the
  // last edits aren't lost, and KEEP the draft. If everything's empty, remove
  // any stale row instead. Skipped when clear() already ran (post-send).
  useEffect(() => {
    if (!enabled) return;
    return () => {
      if (timer.current) clearTimeout(timer.current);
      if (clearedRef.current) return;
      if (!isEmptyRef.current) {
        savedRef.current = true;
        saveDraft({ contextKey, ...valuesRef.current }).catch(() => {});
      } else if (savedRef.current) {
        savedRef.current = false;
        deleteDraft(contextKey).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, contextKey]);

  /** Delete the draft and suppress the close-flush. Call after a send. */
  function clear() {
    if (timer.current) clearTimeout(timer.current);
    clearedRef.current = true;
    if (savedRef.current) {
      savedRef.current = false;
      deleteDraft(contextKey).catch(() => {});
    }
  }

  return { clear };
}
