import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import SenderList from "./SenderList";
import SenderDetail from "./SenderDetail";
import ComposeModal from "./ComposeModal";
import type { Sender } from "@/lib/api";

export default function InboxPage() {
  const [selectedSender, setSelectedSender] = useState<Sender | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  return (
    <>
      {/* Middle panel — sender list (hidden on mobile when a sender is selected) */}
      <div
        className={`w-full md:w-80 shrink-0 border-r border-border-dark bg-panel ${
          selectedSender ? "hidden md:block" : "block"
        }`}
      >
        <SenderList
          selectedSenderId={selectedSender?.id ?? null}
          selectedRecipient={selectedSender?.recipient ?? null}
          onSelectSender={setSelectedSender}
        />
      </div>

      {/* Right panel — email detail (hidden on mobile when no sender selected) */}
      <div
        className={`flex-1 bg-main min-w-0 ${
          selectedSender ? "block" : "hidden md:block"
        }`}
      >
        {selectedSender ? (
          <div className="flex h-full flex-col">
            {/* Mobile back button */}
            <button
              onClick={() => setSelectedSender(null)}
              className="flex items-center gap-1.5 px-4 py-2 text-xs text-text-secondary hover:text-text-primary md:hidden border-b border-border-dark"
            >
              <ArrowLeft size={14} />
              Back
            </button>
            <div className="flex-1 overflow-hidden">
              <SenderDetail sender={selectedSender} />
            </div>
          </div>
        ) : (
          <div className="flex h-full items-center justify-center text-text-tertiary">
            Select a sender to view emails
          </div>
        )}
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
      />
    </>
  );
}
