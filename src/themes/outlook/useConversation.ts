import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchConversationEmails,
  fetchPersonEmails,
  fetchStats,
  type Email,
  type GroupedItem,
  type Stats,
} from "@/lib/api";
import { onEmailSent } from "@/lib/email-events";
import { onInboxRefresh } from "@/lib/inbox-events";

/** Messages of one grouped row, newest first (Outlook's default order). */
export function useConversation(item: GroupedItem | null, label?: string) {
  const [emails, setEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const type = item?.type;
  const id = item?.id;
  // Only the newest request may write state. Without this, a slow response
  // for the previous conversation could land after the user switched, and a
  // reply typed under one person's header would go to another's email.
  const reqId = useRef(0);

  const load = useCallback(
    async (silent = false) => {
      const req = ++reqId.current;
      if (!type || !id) {
        setEmails([]);
        return;
      }
      if (!silent) setLoading(true);
      try {
        const list =
          type === "person"
            ? (await fetchPersonEmails(id, { recipient: label, limit: 100 }))
                .emails
            : (await fetchConversationEmails(id)).emails;
        if (req !== reqId.current) return;
        setEmails([...list].sort((a, b) => b.timestamp - a.timestamp));
        setError(null);
      } catch (e) {
        if (req !== reqId.current) return;
        setError(e instanceof Error ? e.message : "Could not load messages");
      } finally {
        if (!silent && req === reqId.current) setLoading(false);
      }
    },
    [type, id, label],
  );

  useEffect(() => {
    setEmails([]);
    void load();
  }, [load]);

  useEffect(() => onEmailSent(() => void load(true)), [load]);
  useEffect(() => onInboxRefresh(() => void load(true)), [load]);

  return { emails, setEmails, loading, error, reload: load };
}

/** Sender identities and inbox addresses (for From pickers, labels). */
let statsCache: Promise<Stats> | null = null;
export function useIdentities() {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => {
    statsCache ??= fetchStats().catch((e) => {
      statsCache = null;
      throw e;
    });
    statsCache.then(setStats).catch(() => {});
  }, []);
  return {
    recipients: stats?.recipients ?? [],
    senderIdentities: stats?.senderIdentities ?? [],
  };
}

/** Our inbox the message belongs to (where a reply goes out from). */
export function inboxOfEmail(email: Email): string | null {
  return email.type === "sent" ? email.fromAddress : email.recipient;
}

export function internalDomainsOf(
  identities: Array<{ email: string }>,
): string[] {
  const set = new Set<string>();
  for (const s of identities) {
    const at = s.email.lastIndexOf("@");
    if (at >= 0) set.add(s.email.slice(at + 1).toLowerCase());
  }
  return [...set];
}
