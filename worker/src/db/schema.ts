import * as authSchema from "./auth.schema";
import { invitations } from "./invitations.schema";
import { people } from "./people.schema";
import { emails } from "./emails.schema";
import { sentEmails } from "./sent-emails.schema";
import { attachments } from "./attachments.schema";
import { emailTemplates } from "./email-templates.schema";
import { apiKeys } from "./api-keys.schema";
import { sequences } from "./sequences.schema";
import { sequenceEnrollments } from "./sequence-enrollments.schema";
import { sequenceEmails } from "./sequence-emails.schema";
import { senderIdentities } from "./sender-identities.schema";
import { inboxPermissions } from "./inbox-permissions.schema";
import { pushSubscriptions } from "./push-subscriptions.schema";
import { appSettings } from "./app-settings.schema";
import { suppressions } from "./suppressions.schema";
import { blocklist } from "./blocklist.schema";
import { outboxEmails } from "./outbox-emails.schema";
import { drafts } from "./drafts.schema";
import { asyncJobs } from "./async-jobs.schema";
import { contacts } from "./contacts.schema";
import { lists } from "./lists.schema";
import { listMembers } from "./list-members.schema";
import { subscribeForms } from "./subscribe-forms.schema";
import { subscribeAttempts } from "./subscribe-attempts.schema";

export const schema = {
  ...authSchema,
  invitations,
  people,
  emails,
  sentEmails,
  attachments,
  emailTemplates,
  apiKeys,
  sequences,
  sequenceEnrollments,
  sequenceEmails,
  senderIdentities,
  inboxPermissions,
  pushSubscriptions,
  appSettings,
  suppressions,
  blocklist,
  outboxEmails,
  drafts,
  asyncJobs,
  contacts,
  lists,
  listMembers,
  subscribeForms,
  subscribeAttempts,
} as const;
