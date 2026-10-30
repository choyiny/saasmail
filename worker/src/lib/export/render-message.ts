import { sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { toBase64 } from "../email-sender/shared";
import { jsonList } from "../inbox-permissions";
import { addressList, headerText, parameter } from "../../jmap/raw-message";
import type { MailAddress, UnifiedMessage } from "../messages/types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

export interface RenderedMessage {
  bytes: Uint8Array<ArrayBuffer>;
  /** The bytes as received or sent, not rebuilt from what was stored. */
  exact: boolean;
  /** For the mbox separator line. */
  envelopeFrom: string;
  date: Date;
}

/** What rendering needs besides the message: looked up a page at a time. */
export interface RenderHints {
  /** Where the message's own bytes are kept, if they are. */
  rawKey: string | null;
  /** Received mail without kept bytes: its stored headers. */
  headers: Record<string, string> | null;
}

const CRLF = "\r\n";
const FOLD = `${CRLF} `;
const encoder = new TextEncoder();
const NL = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM_ = encoder.encode("From ");

/** Received-mail headers a rebuilt message keeps, when they were stored. */
const KEPT_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "auto-submitted",
  "authentication-results",
  "received-spf",
  "dkim-signature",
  "x-spam-score",
];

/** A stored value as one header line: no CR or LF can start a new header. */
function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function addresses(list: MailAddress[]): string {
  return addressList(
    list.map((address) => ({
      email: oneLine(address.email),
      name: address.name ?? null,
    })),
  );
}

/** Message ids, one per folded line. */
function idList(value: string): string {
  return oneLine(value).trim().split(/\s+/).join(FOLD);
}

/** RFC 5322 date-time in UTC. */
export function rfc5322Date(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
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
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`;
}

/** 64 lines of 76 characters. */
const BASE64_BLOCK = 57 * 64;

/**
 * Base64 in 76-character CRLF lines, written as bytes a block at a time, so
 * a large attachment never becomes one long string.
 */
function wrappedBase64(bytes: Uint8Array): Uint8Array {
  const encodedLength = Math.ceil(bytes.length / 3) * 4;
  const lines = Math.max(1, Math.ceil(encodedLength / 76));
  const out = new Uint8Array(encodedLength + 2 * (lines - 1));
  let offset = 0;
  for (let i = 0; i < bytes.length; i += BASE64_BLOCK) {
    const encoded = toBase64(bytes.subarray(i, i + BASE64_BLOCK));
    for (let j = 0; j < encoded.length; j++) {
      if (j % 76 === 0 && offset > 0) {
        out[offset++] = CR;
        out[offset++] = NL;
      }
      out[offset++] = encoded.charCodeAt(j);
    }
  }
  return out;
}

/**
 * Fixed per message, so rendering the same message twice gives the same bytes
 * (a retried export slice re-uploads identical parts). The parts it separates
 * are base64, which cannot contain it.
 */
function boundary(kind: string, ref: { kind: string; id: string }): string {
  const id = `${ref.kind}-${ref.id}`.replace(/[^A-Za-z0-9_-]/g, "_");
  return `saasmail-${kind}-${id}`.slice(0, 70);
}

/** `/api/attachments/{id}/inline` back to the `cid:` it was rewritten from. */
function restoreCids(
  html: string,
  inline: { id: string; contentId: string }[],
): string {
  let restored = html;
  for (const attachment of inline) {
    restored = restored.replaceAll(
      `/api/attachments/${attachment.id}/inline`,
      `cid:${attachment.contentId}`,
    );
  }
  return restored;
}

function textPart(contentType: string, text: string): (string | Uint8Array)[] {
  return [
    `Content-Type: ${contentType}; charset=utf-8${CRLF}Content-Transfer-Encoding: base64${CRLF}${CRLF}`,
    wrappedBase64(encoder.encode(text.replace(/\r?\n/g, CRLF))),
  ];
}

function concatSegments(
  segments: (string | Uint8Array)[],
): Uint8Array<ArrayBuffer> {
  const parts = segments.map((segment) =>
    typeof segment === "string" ? encoder.encode(segment) : segment,
  );
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export const renderHintKey = (message: UnifiedMessage) =>
  `${message.ref.kind}:${message.ref.id}`;

function parseHeaders(raw: string | null): Record<string, string> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return null;
  }
}

/**
 * For a page of messages, in at most two statements: where each one's own
 * bytes are kept (`emails.raw_r2_key`, or the stored message of a JMAP send),
 * and the stored headers of received mail without them.
 */
export async function loadRenderHints(
  db: Db,
  messages: UnifiedMessage[],
): Promise<Map<string, RenderHints>> {
  const hints = new Map<string, RenderHints>();
  const ids = (kind: "received" | "sent") =>
    messages
      .filter((message) => message.ref.kind === kind)
      .map((message) => message.ref.id);
  const received = ids("received");
  const sent = ids("sent");
  if (received.length > 0) {
    const rows = await db.all<{
      id: string;
      raw_r2_key: string | null;
      raw_headers: string | null;
    }>(sql`
      SELECT id, raw_r2_key,
        CASE WHEN raw_r2_key IS NULL THEN raw_headers END AS raw_headers
      FROM emails WHERE id IN ${jsonList(received)}
    `);
    for (const row of rows) {
      hints.set(`received:${row.id}`, {
        rawKey: row.raw_r2_key,
        headers: parseHeaders(row.raw_headers),
      });
    }
  }
  if (sent.length > 0) {
    const rows = await db.all<{ id: string; raw_r2_key: string }>(sql`
      SELECT se.id AS id, c.raw_r2_key AS raw_r2_key
      FROM sent_emails se
      JOIN jmap_message_content c ON c.id = se.jmap_content_id
      WHERE se.id IN ${jsonList(sent)}
    `);
    for (const row of rows) {
      hints.set(`sent:${row.id}`, { rawKey: row.raw_r2_key, headers: null });
    }
  }
  return hints;
}

/**
 * The bytes of one message, for an `.eml` download or an mbox export: the
 * bytes as received when they were kept (`emails.raw_r2_key`), the stored
 * message of a JMAP send, and otherwise a faithful rebuild from the stored
 * headers, bodies and attachments, marked `X-Saasmail-Reconstructed: yes`.
 * `message` comes from `queryMessages` with attachments and Reply-To;
 * `hints` from `loadRenderHints` (looked up here when not given).
 */
export async function renderMessageBytes(
  db: Db,
  env: CloudflareBindings,
  message: UnifiedMessage,
  hints?: RenderHints | null,
): Promise<RenderedMessage> {
  const date = new Date(message.occurredAt * 1000);
  const envelopeFrom =
    message.from?.email ??
    (message.direction === "outbound" ? message.inbox : "MAILER-DAEMON");
  const known =
    hints === undefined
      ? (await loadRenderHints(db, [message])).get(renderHintKey(message))
      : hints;

  if (known?.rawKey) {
    const object = await env.R2.get(known.rawKey);
    if (object) {
      return {
        bytes: new Uint8Array(await object.arrayBuffer()),
        exact: true,
        envelopeFrom,
        date,
      };
    }
  }

  const headers: string[] = [
    `Date: ${rfc5322Date(date)}`,
    ...(message.from ? [`From: ${addresses([message.from])}`] : []),
    `To: ${addresses([message.to, ...(message.additionalTo ?? [])])}`,
  ];
  if (message.cc.length > 0) headers.push(`Cc: ${addresses(message.cc)}`);
  if ((message.bcc?.length ?? 0) > 0) {
    headers.push(`Bcc: ${addresses(message.bcc!)}`);
  }
  if ((message.replyTo?.length ?? 0) > 0) {
    headers.push(`Reply-To: ${addresses(message.replyTo!)}`);
  }
  headers.push(`Subject: ${headerText(oneLine(message.subject ?? ""))}`);
  if (message.messageId) {
    const id = oneLine(message.messageId).trim().replace(/^<|>$/g, "");
    headers.push(`Message-ID: <${id}>`);
  }
  if (message.inReplyTo) {
    headers.push(`In-Reply-To: ${idList(message.inReplyTo)}`);
  }
  if (message.references) {
    headers.push(`References: ${idList(message.references)}`);
  }
  for (const [name, value] of Object.entries(known?.headers ?? {})) {
    if (
      KEPT_HEADERS.includes(name.toLowerCase()) &&
      /^[\x20-\x7e\t]*$/.test(value) &&
      value.trim() !== ""
    ) {
      headers.push(`${name}: ${value}`);
    }
  }
  headers.push("MIME-Version: 1.0", "X-Saasmail-Reconstructed: yes");

  const attachments = message.attachments ?? [];
  const cid = (contentId: string) =>
    oneLine(contentId).trim().replace(/^<|>$/g, "");
  const inline = attachments
    .filter((attachment) => attachment.contentId)
    .map((attachment) => ({
      id: attachment.id,
      contentId: cid(attachment.contentId!),
    }));
  const html = message.bodyHtml ? restoreCids(message.bodyHtml, inline) : null;
  const text = message.bodyText;

  let body: (string | Uint8Array)[];
  if (text !== null && html !== null) {
    const alt = boundary("alt", message.ref);
    body = [
      `Content-Type: multipart/alternative; boundary="${alt}"${CRLF}${CRLF}--${alt}${CRLF}`,
      ...textPart("text/plain", text),
      `${CRLF}--${alt}${CRLF}`,
      ...textPart("text/html", html),
      `${CRLF}--${alt}--`,
    ];
  } else {
    body = textPart(
      html !== null ? "text/html" : "text/plain",
      html ?? text ?? "",
    );
  }

  const segments: (string | Uint8Array)[] = [`${headers.join(CRLF)}${CRLF}`];
  if (attachments.length > 0) {
    const mixed = boundary("mixed", message.ref);
    segments.push(
      `Content-Type: multipart/mixed; boundary="${mixed}"${CRLF}${CRLF}--${mixed}${CRLF}`,
      ...body,
    );
    for (const attachment of attachments) {
      const object = await env.R2.get(attachment.r2Key);
      if (!object) continue;
      const contentId = attachment.contentId ? cid(attachment.contentId) : null;
      const partHeaders = [
        `Content-Type: ${oneLine(attachment.contentType)}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: ${contentId ? "inline" : "attachment"}; ${parameter("filename", attachment.filename)}`,
        ...(contentId ? [`Content-ID: <${contentId}>`] : []),
      ];
      segments.push(
        `${CRLF}--${mixed}${CRLF}${partHeaders.join(CRLF)}${CRLF}${CRLF}`,
        wrappedBase64(new Uint8Array(await object.arrayBuffer())),
      );
    }
    segments.push(`${CRLF}--${mixed}--`);
  } else {
    segments.push(...body);
  }
  segments.push(CRLF);

  return {
    bytes: concatSegments(segments),
    exact: false,
    envelopeFrom,
    date,
  };
}

/** asctime, as mbox separator lines carry it: "Sat Oct  3 14:02:00 2026". */
export function asctime(date: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
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
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2, " ")} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} ${date.getUTCFullYear()}`;
}

/** Whether the line from `start` to `end` is `>*From `, which mboxrd quotes. */
function needsQuote(source: Uint8Array, start: number, end: number): boolean {
  let probe = start;
  while (probe < end && source[probe] === GT) probe++;
  if (probe + FROM_.length > end) return false;
  for (let i = 0; i < FROM_.length; i++) {
    if (source[probe + i] !== FROM_[i]) return false;
  }
  return true;
}

/** Calls `visit` with each line's start and end (before any CR, then LF). */
function eachLine(
  source: Uint8Array,
  visit: (start: number, end: number, last: boolean) => void,
): void {
  let start = 0;
  for (;;) {
    let next = source.indexOf(NL, start);
    const last = next === -1;
    if (last) next = source.length;
    let end = next;
    if (end > start && source[end - 1] === CR) end--;
    visit(start, end, last);
    if (last) return;
    start = next + 1;
  }
}

/**
 * One mbox entry (mboxrd): the separator line, then `headers` (saasmail's
 * own, one per line), then the message with CRLF made LF and every line that
 * is `From ` after any number of `>` given one more `>`, then a blank line.
 * Sized exactly, so a large message is copied once.
 */
export function mboxEntry(
  rendered: RenderedMessage,
  headers: string[] = [],
): Uint8Array {
  const prefix = encoder.encode(
    `From ${rendered.envelopeFrom.replace(/\s/g, "") || "MAILER-DAEMON"} ${asctime(rendered.date)}\n` +
      headers.map((header) => `${oneLine(header)}\n`).join(""),
  );
  const source = rendered.bytes;
  let size = prefix.length + 2;
  eachLine(source, (start, end, last) => {
    size += end - start + (needsQuote(source, start, end) ? 1 : 0);
    if (!last) size++;
  });
  const out = new Uint8Array(size);
  out.set(prefix, 0);
  let length = prefix.length;
  eachLine(source, (start, end, last) => {
    if (needsQuote(source, start, end)) out[length++] = GT;
    out.set(source.subarray(start, end), length);
    length += end - start;
    if (!last) out[length++] = NL;
  });
  // The message ends with a newline, then a blank line ends the entry.
  if (out[length - 1] !== NL) out[length++] = NL;
  out[length++] = NL;
  return out.subarray(0, length);
}
