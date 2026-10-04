/**
 * Every action the audit log records, by dotted name. Emitters pass one of
 * these to `recordAudit`, so a misspelt name fails `yarn typecheck`. A spec
 * that adds an event adds its name here.
 */
export const AUDIT_ACTIONS = {
  mailSent: "mail.sent",
  mailArchived: "mail.archived",
  mailUnarchived: "mail.unarchived",
  mailSpam: "mail.spam",
  mailNotSpam: "mail.not_spam",
  mailTrashed: "mail.trashed",
  mailRestored: "mail.restored",
  mailMoved: "mail.moved",
  mailSnoozed: "mail.snoozed",
  mailUnsnoozed: "mail.unsnoozed",
  mailAssigned: "mail.assigned",
  mailUnassigned: "mail.unassigned",
  mailDeleted: "mail.deleted",
  settingsChanged: "settings.changed",
  inboxCreated: "inbox.created",
  inboxUpdated: "inbox.updated",
  inboxDeleted: "inbox.deleted",
  folderCreated: "folder.created",
  folderRenamed: "folder.renamed",
  folderUpdated: "folder.updated",
  folderDeleted: "folder.deleted",
  ruleCreated: "rule.created",
  ruleUpdated: "rule.updated",
  ruleDeleted: "rule.deleted",
  ruleToggled: "rule.toggled",
  userInvited: "user.invited",
  userJoined: "user.joined",
  userRoleChanged: "user.role_changed",
  userRemoved: "user.removed",
  userInboxAccessChanged: "user.inbox_access_changed",
  /** An admin changed an account through the auth API: ban, password, sessions. */
  userUpdated: "user.updated",
  /** An admin started acting as another user. */
  userImpersonated: "user.impersonated",
  userPasskeyAdded: "user.passkey_added",
  userPasskeyRemoved: "user.passkey_removed",
  authSignIn: "auth.sign_in",
  authSignInFailed: "auth.sign_in_failed",
  apiKeyCreated: "api_key.created",
  apiKeyRevoked: "api_key.revoked",
  oauthClientRegistered: "oauth.client_registered",
  oauthConsentGranted: "oauth.consent_granted",
  oauthConsentRevoked: "oauth.consent_revoked",
  customerLinked: "customer.linked",
  customerUnlinked: "customer.unlinked",
  customerMerged: "customer.merged",
  sequenceEnrolled: "sequence.enrolled",
  sequenceCancelled: "sequence.cancelled",
  listMemberAdded: "list.member_added",
  listMemberRemoved: "list.member_removed",
  campaignScheduled: "campaign.scheduled",
  sendingPaused: "sending.paused",
  sendingResumed: "sending.resumed",
  sendLimitReached: "send.limit_reached",
  inboundRejected: "inbound.rejected",
  mailAiFileRequested: "mail.ai_file_requested",
  exportStarted: "export.started",
  exportCompleted: "export.completed",
  exportDownloaded: "export.downloaded",
  importStarted: "import.started",
  importCompleted: "import.completed",
  backupStarted: "backup.started",
  backupCompleted: "backup.completed",
  backupFailed: "backup.failed",
  campaignStarted: "campaign.started",
  campaignCancelled: "campaign.cancelled",
  agentActionExecuted: "agent.action_executed",
  agentActionDenied: "agent.action_denied",
} as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** What an event is about; `target_id` identifies one of these. */
export type AuditTargetType =
  | "message"
  | "conversation"
  | "folder"
  | "inbox"
  | "user"
  | "api_key"
  | "rule"
  | "setting"
  | "list"
  | "campaign"
  | "sequence"
  | "customer"
  | "oauth_client"
  | "backup"
  | "import"
  | "export";
