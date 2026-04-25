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
import { agentDefinitions } from "./agent-definitions.schema";
import { agentAssignments } from "./agent-assignments.schema";
import { agentRuns } from "./agent-runs.schema";
import { drafts } from "./drafts.schema";

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
  agentDefinitions,
  agentAssignments,
  agentRuns,
  drafts,
} as const;
