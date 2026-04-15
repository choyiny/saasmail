import { senders } from "./senders.schema";
import { emails } from "./emails.schema";
import { sentEmails } from "./sent-emails.schema";
import { attachments } from "./attachments.schema";

export const schema = {
  senders,
  emails,
  sentEmails,
  attachments,
} as const;
