import { useState } from "react";
import SenderList from "./SenderList";
import SenderDetail from "./SenderDetail";
import ComposeModal from "./ComposeModal";
import type { Sender } from "@/lib/api";

export default function InboxPage() {
  const [selectedSender, setSelectedSender] = useState<Sender | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);

  function handleReply(emailId: string) {
    setReplyToEmailId(emailId);
    setComposeOpen(true);
  }

  return (
    <>
      {/* Middle panel — sender list */}
      <div className="w-80 shrink-0 border-r border-border-dark bg-panel">
        <SenderList
          selectedSenderId={selectedSender?.id ?? null}
          onSelectSender={setSelectedSender}
        />
      </div>

      {/* Right panel — email detail */}
      <div className="flex-1 bg-main">
        {selectedSender ? (
          <SenderDetail sender={selectedSender} onReply={handleReply} />
        ) : (
          <div className="flex h-full items-center justify-center text-text-tertiary">
            Select a sender to view emails
          </div>
        )}
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyToEmailId={replyToEmailId}
      />
    </>
  );
}
