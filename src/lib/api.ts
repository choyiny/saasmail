export interface Person {
  id: string;
  email: string;
  name: string | null;
  recipient: string;
  lastEmailAt: number;
  unreadCount: number;
  totalCount: number;
  latestSubject?: string | null;
}

export interface GroupedPerson {
  type: "person";
  id: string;
  email: string;
  name: string | null;
  lastEmailAt: number;
  unreadCount: number;
  totalCount: number;
  recipientCount: number;
  recipients: string[];
  hasAttachment: number;
}

/**
 * A multi-participant conversation surfaced in the inbox list. Created when
 * a thread has 2+ external participants. Internal teammates can be CC'd
 * without changing the conversation identity — they show up under
 * `ccParticipants`, not as standalone rows.
 */
export interface GroupedConversation {
  type: "group";
  id: string;
  inbox: string;
  participants: Array<{
    id: string;
    email: string;
    name: string | null;
  }>;
  ccParticipants: Array<{
    email: string;
    name: string | null;
  }>;
  lastEmailAt: number;
  unreadCount: number;
  totalCount: number;
  hasAttachment: number;
}

/** Discriminated union — anything that shows up in the inbox sidebar/table. */
export type GroupedItem = GroupedPerson | GroupedConversation;

export interface CcEntry {
  email: string;
  name?: string | null;
}

export interface Email {
  id: string;
  type: "received" | "sent";
  personId: string | null;
  recipient: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: number | null;
  cc: CcEntry[];
  timestamp: number;
  /** Delivery status for sent messages: "sent" | "failed" | "retrying". Null for received. */
  status?: string | null;
  attachmentCount?: number;
  attachments?: Attachment[];
  /** Inbound Reply-To address, surfaced by the single-email endpoint. */
  replyTo?: string | null;
  /** Set when this was a campaign send rather than mail someone wrote. */
  campaignId?: string | null;
}

export type InboxDisplayMode = "thread" | "chat";

export interface InboxMeta {
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
}

export interface PersonEmailsResponse {
  emails: Email[];
  inboxes: InboxMeta[];
}

export interface Attachment {
  id: string;
  emailId: string;
  filename: string;
  contentType: string;
  size: number;
  contentId: string | null;
}

export interface Stats {
  totalPeople: number;
  totalEmails: number;
  unreadCount: number;
  recipients: string[];
  senderIdentities: Array<{
    email: string;
    displayName: string | null;
    signatureHtml: string | null;
  }>;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status}`);
  }
  return res.json();
}

export interface PaginatedPeople {
  data: Person[];
  total: number;
  page: number;
  limit: number;
}

export async function fetchPeople(params?: {
  q?: string;
  recipient?: string;
  personId?: string;
  page?: number;
  limit?: number;
}): Promise<PaginatedPeople> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.personId) qs.set("personId", params.personId);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/people?${qs}`);
}

export async function fetchPerson(id: string): Promise<Person> {
  return apiFetch(`/api/people/${id}`);
}

export interface InboxAggregates {
  /** Number of rows with at least one unread email in the filtered set. */
  unreadRowCount: number;
  /** Number of rows that have at least one downloadable attachment. */
  attachmentRowCount: number;
  /** Number of person rows that span 2+ inboxes (groups don't count). */
  multiInboxRowCount: number;
  /** Sum of unread email counts across the filtered set. */
  totalUnreadEmails: number;
}

export interface PaginatedGroupedPeople {
  /** Mixed list of person + group rows, sorted by the requested key. */
  data: GroupedItem[];
  /** Total rows in the filtered set (across all pages). */
  total: number;
  page: number;
  limit: number;
  /** Aggregates over the *filtered* set so stat tiles don't lie when paged. */
  aggregates: InboxAggregates;
}

export type InboxSort = "recency" | "unread" | "inbox" | "attachments";
export type InboxSortDirection = "asc" | "desc";

export interface InboxSortSpec {
  key: InboxSort;
  direction: InboxSortDirection;
}

/** The natural direction for each sort key. Recency/unread/attachments
 *  default to desc (most recent / most unread / has-attachments-first);
 *  inbox defaults to asc (alphabetical). */
export function defaultDirectionFor(key: InboxSort): InboxSortDirection {
  return key === "inbox" ? "asc" : "desc";
}

export async function fetchGroupedPeople(params?: {
  q?: string;
  recipient?: string;
  unread?: boolean;
  drafts?: boolean;
  sequenced?: boolean;
  sort?: InboxSort;
  /** Optional explicit direction. Server applies the natural default if omitted. */
  direction?: InboxSortDirection;
  page?: number;
  limit?: number;
}): Promise<PaginatedGroupedPeople> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.unread) qs.set("unread", "1");
  if (params?.drafts) qs.set("drafts", "1");
  if (params?.sequenced) qs.set("sequenced", "1");
  if (params?.sort && params.sort !== "recency") qs.set("sort", params.sort);
  // Only send direction when it differs from the natural default —
  // keeps the URL stable for the common case and avoids cache-busting.
  if (
    params?.sort &&
    params?.direction &&
    params.direction !== defaultDirectionFor(params.sort)
  ) {
    qs.set("direction", params.direction);
  }
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/people/grouped?${qs}`);
}

export interface ConversationDetail {
  conversation: {
    id: string;
    inbox: string;
    participants: Array<{
      id: string;
      email: string;
      name: string | null;
    }>;
  };
  emails: Email[];
}

/** Fetch the full chronological timeline for a group conversation. */
export async function fetchConversationEmails(
  conversationId: string,
): Promise<ConversationDetail> {
  return apiFetch(`/api/conversations/${conversationId}/emails`);
}

export async function fetchPersonEmails(
  personId: string,
  params?: { q?: string; recipient?: string; page?: number; limit?: number },
): Promise<PersonEmailsResponse> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/emails/by-person/${personId}?${qs}`);
}

export async function fetchEmail(id: string): Promise<Email> {
  return apiFetch(`/api/emails/${id}`);
}

// Mirrors the worker's SearchHit/SearchEmailsResult (worker/src/lib/queries/
// search.ts). Kept as a local copy rather than imported through `@worker/*`
// because that module's dependency chain pulls worker-only types into the
// frontend typecheck.
export interface SearchHit {
  id: string;
  type: "received" | "sent";
  personId: string | null;
  personEmail: string | null;
  personName: string | null;
  inbox: string;
  subject: string | null;
  snippet: string | null;
  timestamp: number;
  isRead: number | null;
}
export interface SearchResult {
  hits: SearchHit[];
  hasMore: boolean;
  truncated: boolean;
}
export async function searchEmails(params: {
  q: string;
  inbox?: string;
  personId?: string;
  after?: number;
  before?: number;
  page?: number;
  limit?: number;
}): Promise<SearchResult> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.inbox) qs.set("inbox", params.inbox);
  if (params.personId) qs.set("personId", params.personId);
  if (params.after !== undefined) qs.set("after", String(params.after));
  if (params.before !== undefined) qs.set("before", String(params.before));
  if (params.page) qs.set("page", String(params.page));
  if (params.limit) qs.set("limit", String(params.limit));
  return apiFetch(`/api/emails/search?${qs}`);
}

export async function markEmailRead(
  id: string,
  isRead: boolean,
): Promise<void> {
  await apiFetch(`/api/emails/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ isRead }),
  });
}

export async function deleteEmail(
  id: string,
): Promise<{ success: boolean; attachmentsDeleted: number }> {
  return apiFetch(`/api/emails/${id}`, { method: "DELETE" });
}

export interface ReassignPersonResult {
  success: boolean;
  type: "received" | "sent";
  email: {
    id: string;
    personId: string | null;
    toAddress: string | null;
    fromAddress: string | null;
  };
  person: {
    id: string;
    email: string;
    name: string | null;
    created: boolean;
  } | null;
}

/**
 * Re-target a message to a different/new person. For received messages, `email`
 * re-attributes the sender's person. For sent messages, `email` also rewrites
 * the recipient (`toAddress`) so replies route there, and `fromAddress` can
 * switch the sending identity.
 */
export async function reassignEmailPerson(
  emailId: string,
  body: { email?: string; name?: string | null; fromAddress?: string },
): Promise<ReassignPersonResult> {
  return apiFetch(`/api/emails/${emailId}/person`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deletePerson(id: string): Promise<{ success: boolean }> {
  return apiFetch(`/api/people/${id}`, { method: "DELETE" });
}

/** Mark all unread emails for the given people as read.
 *  Optional `recipient` narrows the scope to a single inbox. */
export async function markPeopleRead(
  personIds: string[],
  recipient?: string,
): Promise<{ success: boolean; affected: number }> {
  return apiFetch(`/api/people/mark-read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ personIds, recipient }),
  });
}

/** Mark all unread emails in the given group conversations as read. */
export async function markConversationsRead(
  conversationIds: string[],
): Promise<{ success: boolean; affected: number }> {
  return apiFetch(`/api/conversations/mark-read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationIds }),
  });
}

export interface AttachedFile {
  /** Raw browser File object; included in multipart body. */
  file: File;
}

export async function sendEmail(data: {
  to: string;
  fromAddress: string;
  cc?: CcEntry[];
  subject: string;
  bodyHtml: string;
  bodyText?: string;
  files?: AttachedFile[];
}): Promise<{ id: string; attachmentIds: string[]; status: string }> {
  const { files = [], ...payload } = data;
  const fd = new FormData();
  // Manually composed emails are 1:1 transactional messages: no unsubscribe
  // footer or List-Unsubscribe headers, and they bypass the suppression list
  // (mirrors replies, which are always transactional).
  fd.append("payload", JSON.stringify({ ...payload, transactional: true }));
  for (const af of files) fd.append("files", af.file, af.file.name);
  return apiFetch("/api/send", {
    method: "POST",
    body: fd, // do not set Content-Type; the browser sets the multipart boundary
  });
}

export async function replyToEmail(
  emailId: string,
  data: {
    bodyHtml?: string;
    bodyText?: string;
    fromAddress: string;
    cc?: CcEntry[];
    templateSlug?: string;
    variables?: Record<string, string>;
    files?: AttachedFile[];
  },
): Promise<{ id: string; attachmentIds: string[]; status: string }> {
  const { files = [], ...payload } = data;
  const fd = new FormData();
  fd.append("payload", JSON.stringify(payload));
  for (const af of files) fd.append("files", af.file, af.file.name);
  return apiFetch(`/api/send/reply/${emailId}`, {
    method: "POST",
    body: fd,
  });
}

export async function fetchStats(recipient?: string): Promise<Stats> {
  const qs = recipient ? `?recipient=${recipient}` : "";
  return apiFetch(`/api/stats${qs}`);
}

export interface EmailTemplate {
  id: string;
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
  createdAt: number;
  updatedAt: number;
}

export async function fetchTemplates(): Promise<EmailTemplate[]> {
  return apiFetch("/api/email-templates");
}

export async function fetchTemplate(slug: string): Promise<EmailTemplate> {
  return apiFetch(`/api/email-templates/${slug}`);
}

export async function createTemplate(data: {
  slug: string;
  name: string;
  subject: string;
  bodyHtml: string;
}): Promise<EmailTemplate> {
  return apiFetch("/api/email-templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateTemplate(
  slug: string,
  data: { name?: string; subject?: string; bodyHtml?: string },
): Promise<EmailTemplate> {
  return apiFetch(`/api/email-templates/${slug}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteTemplate(
  slug: string,
): Promise<{ success: boolean }> {
  return apiFetch(`/api/email-templates/${slug}`, {
    method: "DELETE",
  });
}

// --- Compose Drafts (autosave) ---

/** An autosaved compose draft, keyed per user by `contextKey`. */
export interface Draft {
  id: string;
  contextKey: string;
  fromAddress: string | null;
  toAddress: string | null;
  cc: CcEntry[] | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  replyToEmailId: string | null;
  updatedAt: number;
}

export interface DraftInput {
  contextKey: string;
  fromAddress?: string;
  to?: string;
  cc?: CcEntry[];
  subject?: string;
  bodyHtml?: string;
  bodyText?: string;
  replyToEmailId?: string | null;
}

export async function fetchDraft(contextKey: string): Promise<Draft | null> {
  const res = await apiFetch<{ draft: Draft | null }>(
    `/api/drafts?contextKey=${encodeURIComponent(contextKey)}`,
  );
  return res.draft;
}

export async function saveDraft(data: DraftInput): Promise<Draft> {
  const res = await apiFetch<{ draft: Draft }>("/api/drafts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return res.draft;
}

export async function deleteDraft(contextKey: string): Promise<void> {
  await apiFetch(`/api/drafts?contextKey=${encodeURIComponent(contextKey)}`, {
    method: "DELETE",
  });
}

// --- User Management Types ---

export interface Invite {
  id: string;
  token: string;
  role: string;
  email: string | null;
  expiresAt: number;
  usedBy: string | null;
  usedAt: number | null;
  createdBy: string;
  createdAt: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: string | null;
  createdAt: number;
  hasPasskey: boolean;
}

export interface InviteInfo {
  valid: boolean;
  role?: string;
  email?: string | null;
}

// --- Admin API ---

export async function createInvite(data: {
  role: "admin" | "member";
  email?: string;
  expiresInDays?: number;
}): Promise<Invite> {
  return apiFetch<Invite>("/api/admin/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchInvites(): Promise<Invite[]> {
  return apiFetch<Invite[]>("/api/admin/invites");
}

export async function fetchUsers(): Promise<User[]> {
  return apiFetch<User[]>("/api/admin/users");
}

export async function updateUserRole(
  id: string,
  role: "admin" | "member",
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/admin/users/${id}/role`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role }),
  });
}

export async function deleteUser(id: string): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(`/api/admin/users/${id}`, {
    method: "DELETE",
  });
}

export async function revokeInvite(id: string): Promise<{ success: true }> {
  return apiFetch<{ success: true }>(`/api/admin/invites/${id}`, {
    method: "DELETE",
  });
}

// --- Public Invite API ---

export async function validateInvite(token: string): Promise<InviteInfo> {
  return apiFetch<InviteInfo>(`/api/invites/${token}`);
}

export async function acceptInvite(data: {
  token: string;
  name: string;
  email: string;
  password: string;
}): Promise<{ success: boolean; userId: string }> {
  return apiFetch<{ success: boolean; userId: string }>("/api/invites/accept", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

// --- User API ---

export async function fetchPasskeyStatus(): Promise<{ hasPasskey: boolean }> {
  return apiFetch<{ hasPasskey: boolean }>("/api/user/passkeys");
}

// --- API Keys ---

export interface ApiKeyInfo {
  prefix: string;
  createdAt: number;
}

export async function fetchApiKeyInfo(): Promise<{ key: ApiKeyInfo | null }> {
  return apiFetch<{ key: ApiKeyInfo | null }>("/api/api-keys");
}

export async function generateApiKey(): Promise<{
  key: string;
  prefix: string;
  createdAt: number;
}> {
  return apiFetch("/api/api-keys", { method: "POST" });
}

export async function revokeApiKey(): Promise<{ success: boolean }> {
  return apiFetch("/api/api-keys", { method: "DELETE" });
}

// --- Webhook (admin, global instance config) ---

export interface WebhookConfigInfo {
  url: string;
  hasSecret: boolean;
}

export async function fetchWebhookConfig(): Promise<WebhookConfigInfo> {
  return apiFetch<WebhookConfigInfo>("/api/webhook");
}

export async function saveWebhookConfig(body: {
  url: string;
  secret?: string | null;
}): Promise<WebhookConfigInfo> {
  return apiFetch("/api/webhook", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function testWebhook(): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}> {
  return apiFetch("/api/webhook/test", { method: "POST" });
}

// --- Sequences ---

export interface SequenceStep {
  order: number;
  templateSlug: string;
  delayHours: number;
}

export interface Sequence {
  id: string;
  name: string;
  steps: SequenceStep[];
  createdAt: number;
  updatedAt: number;
}

export interface SequenceEmail {
  id: string;
  enrollmentId: string;
  stepOrder: number;
  templateSlug: string;
  scheduledAt: number;
  status: string;
  sentAt: number | null;
  sentEmailId: string | null;
}

export interface SequenceEnrollment {
  id: string;
  sequenceId: string;
  personId: string;
  status: string;
  variables: Record<string, string>;
  enrolledAt: number;
  cancelledAt: number | null;
}

export interface EnrollmentWithDetails extends SequenceEnrollment {
  personEmail: string;
  personName: string | null;
  totalSteps: number;
  sentSteps: number;
}

export interface PersonEnrollmentInfo {
  enrollment: SequenceEnrollment | null;
  scheduledEmails: SequenceEmail[];
  sequenceName: string | null;
}

export async function fetchSequences(): Promise<Sequence[]> {
  return apiFetch("/api/sequences");
}

export async function fetchSequence(id: string): Promise<Sequence> {
  return apiFetch(`/api/sequences/${id}`);
}

export async function createSequence(data: {
  name: string;
  steps: SequenceStep[];
}): Promise<Sequence> {
  return apiFetch("/api/sequences", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateSequence(
  id: string,
  data: { name?: string; steps?: SequenceStep[] },
): Promise<Sequence> {
  return apiFetch(`/api/sequences/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function deleteSequence(
  id: string,
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sequences/${id}`, { method: "DELETE" });
}

export async function enrollPerson(
  sequenceId: string,
  data: {
    personId: string;
    fromAddress: string;
    variables?: Record<string, string>;
    skipSteps?: number[];
    delayOverrides?: Record<string, number>;
  },
): Promise<{
  enrollment: SequenceEnrollment;
  scheduledEmails: SequenceEmail[];
}> {
  return apiFetch(`/api/sequences/${sequenceId}/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function fetchPersonEnrollment(
  personId: string,
): Promise<PersonEnrollmentInfo> {
  return apiFetch(`/api/sequences/people/${personId}/enrollment`);
}

export async function cancelEnrollment(
  enrollmentId: string,
): Promise<{ success: boolean }> {
  return apiFetch(`/api/sequences/enrollments/${enrollmentId}`, {
    method: "DELETE",
  });
}

export async function fetchSequenceEnrollments(
  sequenceId: string,
): Promise<EnrollmentWithDetails[]> {
  return apiFetch(`/api/sequences/${sequenceId}/enrollments`);
}

// --- Admin Inboxes ---

export interface AdminInbox {
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
  signatureHtml: string | null;
  /** Destination address for per-inbox forwarding; null = forwarding off. */
  forwardTo: string | null;
  assignedUserIds: string[];
}

export async function fetchAdminInboxes(): Promise<AdminInbox[]> {
  return apiFetch("/api/admin/inboxes");
}

export async function createInbox(data: {
  email: string;
  displayName?: string | null;
  displayMode?: InboxDisplayMode;
}): Promise<AdminInbox> {
  return apiFetch("/api/admin/inboxes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function updateInboxSettings(
  email: string,
  patch: {
    displayName?: string | null;
    displayMode?: InboxDisplayMode;
    signatureHtml?: string | null;
    forwardTo?: string | null;
  },
): Promise<{
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
  signatureHtml: string | null;
  forwardTo: string | null;
}> {
  return apiFetch(`/api/admin/inboxes/${encodeURIComponent(email)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export async function deleteInbox(
  email: string,
): Promise<{ success: boolean }> {
  return apiFetch<{ success: boolean }>(
    `/api/admin/inboxes/${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
}

export async function updateInboxAssignments(
  email: string,
  userIds: string[],
): Promise<{ email: string; assignedUserIds: string[] }> {
  return apiFetch(
    `/api/admin/inboxes/${encodeURIComponent(email)}/assignments`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userIds }),
    },
  );
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  role: string | null;
}

export async function fetchAdminUsers(): Promise<AdminUser[]> {
  return apiFetch("/api/admin/users");
}

// --- Suppressions ---

export interface Suppression {
  id: string;
  email: string;
  reason: "unsubscribe" | "manual";
  source: string | null;
  note: string | null;
  createdAt: number;
}

export interface SuppressionsPage {
  items: Suppression[];
  nextCursor: string | null;
}

export async function fetchSuppressions(
  cursor?: string | null,
): Promise<SuppressionsPage> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch(`/api/suppressions${qs}`);
}

export async function createSuppression(email: string): Promise<Suppression> {
  return apiFetch("/api/suppressions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });
}

export async function deleteSuppression(
  id: string,
): Promise<{ deleted: true }> {
  return apiFetch(`/api/suppressions/${id}`, { method: "DELETE" });
}

// --- Blocklist ---

export type BlockRuleType = "email" | "domain";

export interface BlockRule {
  id: string;
  type: BlockRuleType;
  value: string;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
}

export interface BlocklistPageResult {
  items: BlockRule[];
  nextCursor: string | null;
}

export async function fetchBlocklist(
  cursor?: string,
): Promise<BlocklistPageResult> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch(`/api/blocklist${qs}`);
}

export async function addBlock(input: {
  type: BlockRuleType;
  value: string;
  note?: string;
}): Promise<BlockRule> {
  return apiFetch("/api/blocklist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function removeBlock(id: string): Promise<{ deleted: true }> {
  return apiFetch(`/api/blocklist/${id}`, { method: "DELETE" });
}

export async function purgeBlockedMail(): Promise<{
  emailsDeleted: number;
  peopleDeleted: number;
}> {
  return apiFetch("/api/blocklist/mail", { method: "DELETE" });
}

// ---- Outbox ----

export interface OutboxItem {
  id: string;
  sentEmailId: string;
  fromAddress: string;
  toAddress: string;
  subject: string;
  status: "pending" | "failed";
  attempts: number;
  lastError: string | null;
  nextRetryAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export async function fetchOutbox(
  cursor?: string,
): Promise<{ items: OutboxItem[]; nextCursor: string | null }> {
  const qs = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  return apiFetch(`/api/outbox${qs}`);
}

export async function fetchOutboxCount(): Promise<{ pending: number }> {
  return apiFetch("/api/outbox/count");
}

export async function retryOutboxItem(id: string): Promise<{
  outcome: "sent" | "suppressed" | "retrying" | "failed" | "pending";
}> {
  return apiFetch(`/api/outbox/${id}/retry`, { method: "POST" });
}

export async function cancelOutboxItem(
  id: string,
): Promise<{ deleted: boolean }> {
  return apiFetch(`/api/outbox/${id}`, { method: "DELETE" });
}

// --- Newsletters: lists, members, subscribe forms, campaigns -----------------

export interface SubscriberList {
  id: string;
  name: string;
  description: string | null;
  fromAddress: string;
  doubleOptIn: boolean;
  confirmationTemplateSlug: string | null;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export type MemberStatus = "pending" | "subscribed" | "unsubscribed";

export interface ListMember {
  id: string;
  listId: string;
  contactId: string;
  email: string;
  name: string | null;
  status: MemberStatus;
  source: "form" | "api" | "import";
  consentSource: "form" | "api" | "import";
  consentAt: number | null;
  subscribedAt: number | null;
  confirmedAt: number | null;
  unsubscribedAt: number | null;
  createdAt: number;
}

export interface ImportJob {
  jobId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  totalRows: number | null;
  processedRows: number;
  importedCount: number;
  skippedCount: number;
  errors: Array<{ row: number; reason: string }>;
}

export interface SubscribeForm {
  id: string;
  listId: string;
  name: string;
  showNameField: boolean;
  nameRequired: boolean;
  successMessage: string;
  redirectUrl: string | null;
  allowedOrigins: string | null;
  /**
   * Copy-paste markup, built server-side. It carries the honeypot field the
   * public subscribe endpoint checks by name, so it must never be rebuilt on
   * the client. Present on create and on the single-form read.
   */
  embedSnippet?: string;
  createdAt: number;
  updatedAt: number;
}

export type CampaignStatus =
  | "draft"
  | "scheduled"
  | "overdue"
  | "preparing"
  | "sending"
  | "sent"
  | "completed_with_failures"
  | "cancelled"
  | "stalled";

export interface Campaign {
  id: string;
  name: string;
  subject: string;
  templateSlug: string;
  fromAddress: string;
  listId: string;
  status: CampaignStatus;
  scheduledAt: number | null;
  sentAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CampaignStats {
  targeted: number;
  delivered: number;
  suppressed: number;
  retryableFailed: number;
  permanentFailed: number;
  unsubscribes: number;
  /** Approximate — see the tracking caveat in docs/newsletters.md. */
  uniqueOpeners: number;
  /** Approximate, and identical to "unique clickers" by schema construction. */
  uniqueClicks: number;
}

export type CampaignDetail = Campaign & { stats: CampaignStats };

export interface CampaignTimeseriesPoint {
  hour: number;
  opens: number;
  clicks: number;
}

export interface CampaignLinkStat {
  url: string;
  clicks: number;
  clickRate: number;
}

export async function fetchLists(params?: {
  includeArchived?: boolean;
}): Promise<{ items: SubscriberList[]; nextCursor: string | null }> {
  const qs = params?.includeArchived ? "?includeArchived=true" : "";
  return apiFetch(`/api/lists${qs}`);
}

export async function fetchList(id: string): Promise<SubscriberList> {
  return apiFetch(`/api/lists/${id}`);
}

export async function createList(body: {
  name: string;
  description?: string | null;
  fromAddress: string;
  doubleOptIn?: boolean;
  confirmationTemplateSlug?: string | null;
}): Promise<SubscriberList> {
  return apiFetch("/api/lists", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateList(
  id: string,
  body: Partial<{
    name: string;
    description: string | null;
    fromAddress: string;
    doubleOptIn: boolean;
    confirmationTemplateSlug: string | null;
  }>,
): Promise<SubscriberList> {
  return apiFetch(`/api/lists/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Archives instead of deleting once the list has campaign history. */
export async function deleteList(id: string): Promise<void> {
  await apiFetch(`/api/lists/${id}`, { method: "DELETE" });
}

export async function fetchListMembers(
  id: string,
  params?: { status?: MemberStatus; cursor?: string; limit?: number },
): Promise<{ items: ListMember[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.cursor) qs.set("cursor", params.cursor);
  if (params?.limit) qs.set("limit", String(params.limit));
  return apiFetch(`/api/lists/${id}/members?${qs}`);
}

export async function addListMember(
  id: string,
  body: { email: string; name?: string | null },
): Promise<ListMember> {
  return apiFetch(`/api/lists/${id}/members`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Sets `status = 'unsubscribed'`; the consent record is never deleted. */
export async function unsubscribeListMember(
  id: string,
  memberId: string,
): Promise<void> {
  await apiFetch(`/api/lists/${id}/members/${memberId}`, { method: "DELETE" });
}

export function listMembersExportUrl(id: string): string {
  return `/api/lists/${id}/members/export`;
}

export async function startListImport(
  id: string,
  file: File,
): Promise<{ jobId: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch(`/api/lists/${id}/members/import`, {
    method: "POST",
    credentials: "include",
    body: form,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function fetchImportJob(
  id: string,
  jobId: string,
): Promise<ImportJob> {
  return apiFetch(`/api/lists/${id}/members/import/${jobId}`);
}

export async function cancelImportJob(
  id: string,
  jobId: string,
): Promise<void> {
  await apiFetch(`/api/lists/${id}/members/import/${jobId}`, {
    method: "DELETE",
  });
}

export async function fetchSubscribeForms(): Promise<{
  items: SubscribeForm[];
}> {
  return apiFetch("/api/subscribe-forms");
}

export async function fetchSubscribeForm(id: string): Promise<SubscribeForm> {
  return apiFetch(`/api/subscribe-forms/${id}`);
}

export async function createSubscribeForm(body: {
  listId: string;
  name: string;
  showNameField?: boolean;
  nameRequired?: boolean;
  successMessage?: string;
  redirectUrl?: string | null;
  allowedOrigins?: string | null;
}): Promise<SubscribeForm> {
  return apiFetch("/api/subscribe-forms", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateSubscribeForm(
  id: string,
  body: Partial<{
    name: string;
    showNameField: boolean;
    nameRequired: boolean;
    successMessage: string;
    redirectUrl: string | null;
    allowedOrigins: string | null;
  }>,
): Promise<SubscribeForm> {
  return apiFetch(`/api/subscribe-forms/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteSubscribeForm(id: string): Promise<void> {
  await apiFetch(`/api/subscribe-forms/${id}`, { method: "DELETE" });
}

export async function fetchCampaigns(): Promise<{
  items: Campaign[];
  nextCursor: string | null;
}> {
  return apiFetch("/api/campaigns");
}

export async function fetchCampaign(id: string): Promise<CampaignDetail> {
  return apiFetch(`/api/campaigns/${id}`);
}

export async function createCampaign(body: {
  name: string;
  subject: string;
  templateSlug: string;
  listId: string;
}): Promise<Campaign> {
  return apiFetch("/api/campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function updateCampaign(
  id: string,
  body: Partial<{
    name: string;
    subject: string;
    templateSlug: string;
    listId: string;
  }>,
): Promise<Campaign> {
  return apiFetch(`/api/campaigns/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteCampaign(id: string): Promise<void> {
  await apiFetch(`/api/campaigns/${id}`, { method: "DELETE" });
}

/**
 * Campaign actions. Each answers 409 when the campaign's current status does
 * not permit it — the state machine is enforced server-side, and the UI only
 * mirrors it.
 */
async function campaignAction<T>(
  id: string,
  action: string,
  body?: unknown,
): Promise<T> {
  return apiFetch(`/api/campaigns/${id}/${action}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const sendCampaign = (id: string) =>
  campaignAction<{ status: string }>(id, "send");
export const scheduleCampaign = (id: string, scheduledAt: number) =>
  campaignAction<{ status: string }>(id, "schedule", { scheduledAt });
export const cancelCampaign = (id: string) =>
  campaignAction<{ status: string }>(id, "cancel");
export const retryCampaign = (id: string) =>
  campaignAction<{ requeued: number }>(id, "retry");
export const testSendCampaign = (id: string) =>
  campaignAction<{ sent: boolean }>(id, "test-send");

export async function fetchCampaignPreview(
  id: string,
): Promise<{ subject: string; html: string }> {
  return apiFetch(`/api/campaigns/${id}/preview`);
}

export async function fetchCampaignTimeseries(
  id: string,
): Promise<{ data: CampaignTimeseriesPoint[] }> {
  return apiFetch(`/api/campaigns/${id}/stats/timeseries`);
}

export async function fetchCampaignLinks(
  id: string,
): Promise<{ data: CampaignLinkStat[] }> {
  return apiFetch(`/api/campaigns/${id}/links`);
}

export interface ContactExport {
  email: string;
  contact: { id: string; name: string | null; createdAt: number } | null;
  memberships: Array<ListMember & { listName: string | null }>;
  events: Array<{
    id: string;
    campaignId: string;
    eventType: "open" | "click";
    occurredAt: number;
  }>;
}

export async function exportContact(email: string): Promise<ContactExport> {
  return apiFetch(`/api/contacts/${encodeURIComponent(email)}/export`);
}

export async function eraseContact(email: string): Promise<{
  contacts: number;
  memberships: number;
  events: number;
  recipients: number;
  attempts: number;
}> {
  return apiFetch(`/api/contacts/${encodeURIComponent(email)}/erase`, {
    method: "POST",
  });
}

export interface ListMembershipSummary {
  listId: string;
  listName: string;
  status: MemberStatus;
  subscribedAt: number | null;
  unsubscribedAt: number | null;
}

export async function fetchListMemberships(
  email: string,
): Promise<{ items: ListMembershipSummary[] }> {
  return apiFetch(`/api/lists/memberships?email=${encodeURIComponent(email)}`);
}
