interface ComposeModalProps {
  open: boolean;
  onClose: () => void;
  replyToEmailId: string | null;
}

export default function ComposeModal({ open }: ComposeModalProps) {
  if (!open) return null;
  return <div>Compose — coming soon</div>;
}
