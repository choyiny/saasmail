import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { fetchListMemberships, type ListMembershipSummary } from "@/lib/api";

const STATUS_STYLE: Record<ListMembershipSummary["status"], string> = {
  subscribed: "bg-emerald-500/10 text-emerald-700",
  pending: "bg-amber-500/10 text-amber-700",
  unsubscribed: "bg-bg-muted text-text-tertiary",
};

/**
 * Which newsletter lists this correspondent is on.
 *
 * Renders nothing when there are none — most people in an inbox are not
 * subscribers, and an empty section on every profile is noise. It also stays
 * silent on failure: a caller without list access should see the person, not
 * an error about a feature they cannot use.
 */
export default function PersonListMemberships({ email }: { email: string }) {
  const [items, setItems] = useState<ListMembershipSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchListMemberships(email)
      .then((r) => {
        if (!cancelled) setItems(r.items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [email]);

  if (items.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-text-tertiary">
        Lists
      </span>
      {items.map((m) => (
        <Link
          key={m.listId}
          to={`/lists/${m.listId}`}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_STYLE[m.status]}`}
          title={`${m.listName} — ${m.status}`}
        >
          {m.listName}
        </Link>
      ))}
    </div>
  );
}
