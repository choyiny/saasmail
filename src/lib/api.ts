export interface Sender {
  id: string;
  email: string;
  name: string | null;
  lastEmailAt: number;
  unreadCount: number;
  totalCount: number;
  latestSubject?: string | null;
}

export interface Email {
  id: string;
  type: "received" | "sent";
  senderId: string | null;
  recipient: string | null;
  fromAddress: string | null;
  toAddress: string | null;
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: number | null;
  timestamp: number;
  attachmentCount?: number;
  attachments?: Attachment[];
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
  totalSenders: number;
  totalEmails: number;
  unreadCount: number;
  recipients: string[];
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

export async function fetchSenders(params?: {
  q?: string;
  recipient?: string;
  page?: number;
  limit?: number;
}): Promise<Sender[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/senders?${qs}`);
}

export async function fetchSender(id: string): Promise<Sender> {
  return apiFetch(`/api/senders/${id}`);
}

export async function fetchSenderEmails(
  senderId: string,
  params?: { q?: string; recipient?: string; page?: number; limit?: number },
): Promise<Email[]> {
  const qs = new URLSearchParams();
  if (params?.q) qs.set("q", params.q);
  if (params?.recipient) qs.set("recipient", params.recipient);
  if (params?.page) qs.set("page", params.page.toString());
  if (params?.limit) qs.set("limit", params.limit.toString());
  return apiFetch(`/api/emails/by-sender/${senderId}?${qs}`);
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

export async function sendEmail(data: {
  to: string;
  subject: string;
  bodyHtml: string;
  bodyText?: string;
}): Promise<{ id: string }> {
  return apiFetch("/api/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
}

export async function replyToEmail(
  emailId: string,
  data: {
    bodyHtml?: string;
    bodyText?: string;
    fromAddress?: string;
    templateSlug?: string;
    variables?: Record<string, string>;
  },
): Promise<{ id: string }> {
  return apiFetch(`/api/send/reply/${emailId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
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
  senderId: string;
  status: string;
  variables: Record<string, string>;
  enrolledAt: number;
  cancelledAt: number | null;
}

export interface EnrollmentWithDetails extends SequenceEnrollment {
  senderEmail: string;
  senderName: string | null;
  totalSteps: number;
  sentSteps: number;
}

export interface SenderEnrollmentInfo {
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

export async function enrollSender(
  sequenceId: string,
  data: {
    senderId: string;
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

export async function fetchSenderEnrollment(
  senderId: string,
): Promise<SenderEnrollmentInfo> {
  return apiFetch(`/api/sequences/senders/${senderId}/enrollment`);
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

// --- OAuth Apps ---

export interface OAuthApp {
  clientId: string;
  name: string | null;
  createdAt: number;
}

export async function fetchOAuthApps(): Promise<OAuthApp[]> {
  return apiFetch("/api/oauth-apps");
}

export async function revokeOAuthApp(
  clientId: string,
): Promise<{ success: boolean }> {
  return apiFetch(`/api/oauth-apps/${clientId}`, { method: "DELETE" });
}
