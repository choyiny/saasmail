import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Archive, ChevronLeft } from "lucide-react";
import { fetchList, updateList, type SubscriberList } from "@/lib/api";
import { PageContainer } from "@/components/PageHeader";
import ListMembersTable from "@/components/ListMembersTable";

export default function ListDetailPage() {
  const { id = "" } = useParams();
  const [list, setList] = useState<SubscriberList | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchList(id)
      .then(setList)
      .catch(() => setList(null))
      .finally(() => setLoading(false));
  }, [id]);

  async function toggleDoubleOptIn() {
    if (!list) return;
    setSaving(true);
    try {
      setList(await updateList(id, { doubleOptIn: !list.doubleOptIn }));
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <PageContainer>
        <p className="text-sm font-light text-text-tertiary">Loading…</p>
      </PageContainer>
    );
  }

  if (!list) {
    return (
      <PageContainer>
        <p className="text-sm text-text-tertiary">
          This list doesn't exist, or you don't have access to it.
        </p>
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <Link
        to="/lists"
        className="mb-4 inline-flex items-center gap-1 text-xs font-medium text-text-tertiary hover:text-text-primary"
      >
        <ChevronLeft size={12} />
        Lists
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight text-text-primary">
              {list.name}
            </h1>
            {list.archivedAt !== null && (
              <span className="inline-flex items-center gap-1 rounded-full bg-bg-muted px-2 py-0.5 text-[10px] font-medium text-text-tertiary">
                <Archive size={9} />
                archived
              </span>
            )}
          </div>
          <p className="mt-1 text-sm font-light text-text-tertiary">
            {list.description || "No description"} · sends from{" "}
            {list.fromAddress}
          </p>
        </div>
        <button
          onClick={toggleDoubleOptIn}
          disabled={saving || list.archivedAt !== null}
          className="rounded-[6px] px-3 py-2 text-xs font-medium text-text-secondary ring-1 ring-border hover:bg-bg-muted disabled:opacity-50"
        >
          {list.doubleOptIn ? "Double opt-in: on" : "Double opt-in: off"}
        </button>
      </div>

      {list.archivedAt !== null && (
        <p className="mb-4 rounded-[8px] bg-bg-muted p-3 text-xs text-text-secondary">
          This list is archived because it has campaign history. Its delivery
          and consent records are intact, but it no longer appears when choosing
          a list to send to.
        </p>
      )}

      <ListMembersTable listId={id} />
    </PageContainer>
  );
}
