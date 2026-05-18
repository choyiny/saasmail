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
  attachmentCount?: number;
  attachments?: Attachment[];
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
  hasAttachment?: boolean;
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
  if (params?.hasAttachment) qs.set("hasAttachment", "1");
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
  fd.append("payload", JSON.stringify(payload));
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
  },
): Promise<{
  email: string;
  displayName: string | null;
  displayMode: InboxDisplayMode;
  signatureHtml: string | null;
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
