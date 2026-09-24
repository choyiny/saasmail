import { useState } from "react";
import { useSession } from "@/lib/auth-client";
import { Navigate } from "react-router-dom";
import AdminInboxTable from "@/components/AdminInboxTable";
import ConnectedMailboxes from "@/components/ConnectedMailboxes";
import PageHeader, { PageContainer } from "@/components/PageHeader";

export default function InboxesPage() {
  const { data: session } = useSession();
  // Bumped whenever the section above connects or disconnects a mailbox. The
  // table below lists those mailboxes in its Source control and a disconnect
  // unmaps inboxes server-side, so without this the table keeps showing a
  // mailbox that is gone — or omitting one that was just added — until the
  // operator reloads the page.
  const [gmailVersion, setGmailVersion] = useState(0);
  if (session?.user?.role !== "admin") {
    return <Navigate to="/" replace />;
  }
  return (
    <PageContainer>
      <PageHeader
        title="Inboxes"
        subtitle="Set display names, choose chat or thread mode, forward mail onward, and assign member access."
      />
      <ConnectedMailboxes
        onMailboxesChanged={() => setGmailVersion((v) => v + 1)}
      />
      <AdminInboxTable gmailVersion={gmailVersion} />
    </PageContainer>
  );
}
