import type { Sender } from "@/lib/api";

interface SenderDetailProps {
  sender: Sender;
  onReply: (emailId: string) => void;
}

export default function SenderDetail({ sender }: SenderDetailProps) {
  return <div className="p-4">Emails from {sender.name || sender.email} — coming next</div>;
}
