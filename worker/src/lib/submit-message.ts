import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  contentLeaves as leavesOfPart,
  type ContentAddress,
  type ContentLeaf,
  type ContentPart,
  type JmapContentRow,
} from "../jmap/content";
import type { EmailSender, SendEmailAttachment } from "./email-sender";
import { encodeDisplayName } from "./format-from-address";
import {
  sendViaOutbox,
  type BookkeepingOwner,
  type OutboxSendResult,
} from "./outbox";
import type { CcRecipient } from "./send";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** Everything the outbox needs to send one JMAP submission exactly. */
export type SubmissionMessage = {
  fromAddress: string;
  from: string;
  to: string;
  toName: string | null;
  cc: CcRecipient[];
  subject: string;
  html: string;
  text: string | undefined;
  headers: Record<string, string>;
  attachments: SendEmailAttachment[];
};

export function parseContentJson<T>(value: string | null, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  return JSON.parse(value) as T;
}

/** Every leaf of a content row's part tree, keyed by partId. */
export function contentLeaves(
  content: JmapContentRow,
): Map<string, ContentLeaf> {
  const leaves = new Map<string, ContentLeaf>();
  for (const leaf of leavesOfPart(
    JSON.parse(content.partsJson) as ContentPart,
  )) {
    leaves.set(leaf.partId, leaf);
  }
  return leaves;
}

/**
 * The part ids each body is sent from. RFC 8621's textBody/htmlBody are
 * display lists: a lone text/plain part is in htmlBody too, a lone text/html
 * part in textBody, and inline images sit in both. The sent text is only the
 * text/plain values of textBody, the sent HTML only the text/html values of
 * htmlBody.
 */
function bodyPartIds(
  content: JmapContentRow,
  leaves: Map<string, ContentLeaf>,
): { text: string[]; html: string[] } {
  const ofType = (listJson: string, type: string) =>
    parseContentJson<string[]>(listJson, []).filter((partId) => {
      const leaf = leaves.get(partId);
      return leaf?.type === type && leaf.r2Key === null;
    });
  return {
    text: ofType(content.textBodyJson, "text/plain"),
    html: ofType(content.htmlBodyJson, "text/html"),
  };
}

/**
 * Every stored (blob) leaf of the content, in tree order: each goes out as an
 * attachment, inline or not. Following `attachments` instead would drop an
 * inline image RFC 8621 lists as a body part.
 */
export function submissionAttachmentLeaves(
  content: JmapContentRow,
): ContentLeaf[] {
  return [...contentLeaves(content).values()].filter(
    (leaf) => leaf.r2Key !== null,
  );
}

/** The filename a stored leaf is sent under, on the first attempt and on retries. */
export function submissionAttachmentFilename(leaf: ContentLeaf): string {
  return leaf.name ?? `attachment-${leaf.partId}`;
}

/** Text leaves that are neither sent body: there is no way to send them. */
export function submissionUnsendableLeaves(
  content: JmapContentRow,
): ContentLeaf[] {
  const leaves = contentLeaves(content);
  const bodies = bodyPartIds(content, leaves);
  const sent = new Set([...bodies.text, ...bodies.html]);
  return [...leaves.values()].filter(
    (leaf) => leaf.r2Key === null && !sent.has(leaf.partId),
  );
}

function bodyValue(
  partIds: string[],
  values: Record<string, string>,
): string | null {
  const parts = partIds
    .map((partId) => values[partId])
    .filter((value): value is string => typeof value === "string");
  return parts.length > 0 ? parts.join("\n") : null;
}

function bracketed(id: string): string {
  return id.startsWith("<") ? id : `<${id}>`;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** RFC 5322 `Date` for an RFC 3339 timestamp, keeping its written offset. */
export function formatRfc5322Date(value: string): string {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`invalid sentAt: ${value}`);
  const offset = /([+-])(\d{2}):?(\d{2})$/.exec(value);
  const offsetMinutes =
    offset && !/[zZ]$/.test(value)
      ? (offset[1] === "-" ? -1 : 1) *
        (Number(offset[2]) * 60 + Number(offset[3]))
      : 0;
  const local = new Date(millis + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  return (
    `${DAYS[local.getUTCDay()]}, ${pad(local.getUTCDate())} ` +
    `${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} ` +
    `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())} ` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

/**
 * The exact message for a draft's content: From (name + email), one To and the
 * Cc with display names, the subject as stored (no "Re:" rewrite), bodies,
 * Message-ID, In-Reply-To, References, Reply-To, Date and the given
 * attachments.
 *
 * The From display name is the content's own `from[0].name`; the identity's
 * display name is only a fallback, because the draft's raw blob and its Sent
 * projection both show the content.
 */
/**
 * The exact `From` header a submission sends with (spec §10.1). Split out so the
 * intention can freeze it before the staged attachments exist, while
 * `buildSubmissionMessage` stays the single place the rule is written.
 */
export function submissionFromHeader(
  content: JmapContentRow,
  identity: { email: string; displayName: string | null },
): string {
  const fromAddress = identity.email.trim().toLowerCase();
  const fromName =
    parseContentJson<ContentAddress[]>(content.fromJson, [])[0]?.name ??
    identity.displayName ??
    null;
  return fromName
    ? `${encodeDisplayName(fromName)} <${fromAddress}>`
    : fromAddress;
}

export function buildSubmissionMessage(
  content: JmapContentRow,
  identity: { email: string; displayName: string | null },
  attachments: SendEmailAttachment[],
): SubmissionMessage {
  const fromAddress = identity.email.trim().toLowerCase();
  const to = parseContentJson<ContentAddress[]>(content.toJson, [])[0];
  if (!to) throw new Error("content has no To address");
  const values = parseContentJson<Record<string, string>>(
    content.bodyValuesJson,
    {},
  );
  const inReplyTo = parseContentJson<string[] | null>(
    content.inReplyToJson,
    null,
  );
  const references = parseContentJson<string[] | null>(
    content.referencesJson,
    null,
  );

  const headers: Record<string, string> = {
    "Message-ID": bracketed(content.messageId),
    Date: formatRfc5322Date(content.sentAt),
  };
  if (inReplyTo && inReplyTo.length > 0) {
    headers["In-Reply-To"] = inReplyTo.map(bracketed).join(" ");
  }
  if (references && references.length > 0) {
    headers.References = references.map(bracketed).join(" ");
  }
  // One bare address, as the web composer sends it: every provider takes
  // Reply-To as a single mailbox. Submission refuses more than one.
  const replyTo = parseContentJson<ContentAddress[] | null>(
    content.replyToJson,
    null,
  )?.[0];
  if (replyTo) headers["Reply-To"] = replyTo.email.trim().toLowerCase();
  const bodies = bodyPartIds(content, contentLeaves(content));

  return {
    fromAddress,
    from: submissionFromHeader(content, identity),
    to: to.email.trim().toLowerCase(),
    toName: to.name ?? null,
    cc: parseContentJson<ContentAddress[]>(content.ccJson, []).map(
      (address) => ({
        email: address.email.trim().toLowerCase(),
        name: address.name ?? null,
      }),
    ),
    subject: content.subject,
    html: bodyValue(bodies.html, values) ?? "",
    text: bodyValue(bodies.text, values) ?? undefined,
    headers,
    attachments,
  };
}

/** One transactional outbox send of a submission (spec J4, §3.4 step 2). */
export async function sendSubmission(params: {
  db: Db;
  env: CloudflareBindings;
  sender: EmailSender;
  sentEmailId: string;
  message: SubmissionMessage;
  bookkeepingOwner: BookkeepingOwner | null;
}): Promise<OutboxSendResult> {
  const { message } = params;
  return sendViaOutbox({
    db: params.db,
    env: params.env,
    sender: params.sender,
    sentEmailId: params.sentEmailId,
    bookkeepingOwner: params.bookkeepingOwner,
    fromAddress: message.fromAddress,
    from: message.from,
    to: message.to,
    toName: message.toName,
    cc: message.cc.length > 0 ? message.cc : undefined,
    subject: message.subject,
    html: message.html,
    text: message.text,
    headers: message.headers,
    attachments:
      message.attachments.length > 0 ? message.attachments : undefined,
    transactional: true,
  });
}
