import { useSession } from "@/lib/auth-client";
import { Navigate } from "react-router-dom";
import AdminInboxTable from "@/components/AdminInboxTable";
import PageHeader, { PageContainer } from "@/components/PageHeader";

export default function InboxesPage() {
  const { data: session } = useSession();
  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return (
    <PageContainer>
      <PageHeader
        title="Inboxes"
        subtitle="Set display names, choose chat or thread mode, forward mail onward, and assign member access."
      />
      <AdminInboxTable />
    </PageContainer>
  );
}
