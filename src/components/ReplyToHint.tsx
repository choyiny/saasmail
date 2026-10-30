import { cn } from "@/lib/utils";

interface ReplyToHintProps {
  /**
   * Every address the reply uses when it follows the message's Reply-To: the
   * first is To, the others are copied. Never empty.
   */
  recipients: { email: string }[];
  /** True when the user chose to answer the sender instead. */
  toSender: boolean;
  onToggle: (toSender: boolean) => void;
  className?: string;
}

/**
 * Shown by the reply composers when the message being answered asked for
 * replies at other addresses: names every address the reply will reach and
 * lets the user answer the sender instead.
 */
export default function ReplyToHint({
  recipients,
  toSender,
  onToggle,
  className,
}: ReplyToHintProps) {
  const [first, ...copied] = recipients.map((entry) => entry.email);
  return (
    <div
      data-testid="reply-to-hint"
      className={cn(
        "flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-text-secondary",
        className,
      )}
    >
      <span>
        {toSender
          ? "This reply is addressed to the sender; the message's Reply-To is not used"
          : `Replies go to ${first}${
              copied.length > 0 ? `, with ${copied.join(", ")} in Cc` : ""
            } (the sender asked for replies there)`}
      </span>
      <label className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-text-primary">
        <input
          type="checkbox"
          checked={toSender}
          onChange={(event) => onToggle(event.target.checked)}
          className="h-3 w-3 accent-text-primary"
        />
        Reply to the sender instead
      </label>
    </div>
  );
}
