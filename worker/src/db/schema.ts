import * as authSchema from "./auth.schema";
import { senders } from "./senders.schema";
import { emails } from "./emails.schema";
import { sentEmails } from "./sent-emails.schema";
import { attachments } from "./attachments.schema";
import { apiKeys } from "./api-keys.schema";

export const schema = {
  ...authSchema,
  senders,
  emails,
  sentEmails,
  attachments,
  apiKeys,
} as const;
