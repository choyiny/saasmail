import { isSystemDescriptor, type MailboxDescriptor } from "./mailboxes";

type SetError = { type: string; properties?: string[] };

/**
 * A draft's mailboxes: exactly one system mailbox of its own inbox, Drafts or
 * Trash, plus any custom folders of that inbox (spec 2026-09-28). Shared by
 * `Email/set` create and update.
 */
export function validateDraftTarget(
  inbox: string,
  targetIds: Set<string>,
  descriptorsById: Map<string, MailboxDescriptor>,
): { role: "drafts" | "trash"; folders: string[] } | SetError {
  const invalid = { type: "invalidProperties", properties: ["mailboxIds"] };
  const normalizedInbox = inbox.toLowerCase();
  let role: "drafts" | "trash" | null = null;
  const folders: string[] = [];
  for (const id of targetIds) {
    const descriptor = descriptorsById.get(id);
    if (!descriptor || descriptor.inbox.toLowerCase() !== normalizedInbox) {
      return invalid;
    }
    if (isSystemDescriptor(descriptor)) {
      if (role !== null) return invalid;
      if (descriptor.role !== "drafts" && descriptor.role !== "trash") {
        return invalid;
      }
      role = descriptor.role;
    } else {
      folders.push(
        (descriptor as Extract<MailboxDescriptor, { kind: "custom" }>)
          .mailboxId,
      );
    }
  }
  if (role === null) return invalid;
  return { role, folders };
}
