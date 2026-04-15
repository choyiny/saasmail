import { useState } from "react";
import { Link } from "react-router-dom";
import { signOut, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import SenderList from "./SenderList";
import SenderDetail from "./SenderDetail";
import ComposeModal from "./ComposeModal";
import type { Sender } from "@/lib/api";

export default function InboxPage() {
  const { data: session } = useSession();
  const [selectedSender, setSelectedSender] = useState<Sender | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [replyToEmailId, setReplyToEmailId] = useState<string | null>(null);

  function handleCompose() {
    setReplyToEmailId(null);
    setComposeOpen(true);
  }

  function handleReply(emailId: string) {
    setReplyToEmailId(emailId);
    setComposeOpen(true);
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b px-4 py-2">
        <h1 className="text-lg font-semibold">cmail</h1>
        <div className="flex items-center gap-2">
          {session?.user?.role === "admin" && (
            <Link
              to="/admin/users"
              className="text-sm text-neutral-500 hover:text-neutral-700"
            >
              Users
            </Link>
          )}
          <Link
            to="/templates"
            className="text-sm text-neutral-500 hover:text-neutral-700"
          >
            Templates
          </Link>
          <Button size="sm" onClick={handleCompose}>
            Compose
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                {session?.user?.email}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => signOut()}>
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-80 shrink-0">
          <SenderList
            selectedSenderId={selectedSender?.id ?? null}
            onSelectSender={setSelectedSender}
          />
        </div>
        <div className="flex-1">
          {selectedSender ? (
            <SenderDetail sender={selectedSender} onReply={handleReply} />
          ) : (
            <div className="flex h-full items-center justify-center text-neutral-400">
              Select a sender to view emails
            </div>
          )}
        </div>
      </div>

      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyToEmailId={replyToEmailId}
      />
    </div>
  );
}
