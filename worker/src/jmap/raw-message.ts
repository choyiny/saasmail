import { toBase64 } from "../lib/email-sender/shared";
import { encodeDisplayName } from "../lib/format-from-address";
import {
  isMultipart,
  toCrlf,
  utf8Bytes,
  type ContentAddress,
  type ContentLeaf,
  type ContentPart,
} from "./content";

export type RawMessageInput = {
  contentId: string;
  from: ContentAddress;
  to: ContentAddress[];
  cc: ContentAddress[];
  replyTo: ContentAddress[] | null;
  subject: string;
  /** Without angle brackets. */
  messageId: string;
  inReplyTo: string[] | null;
  references: string[] | null;
  /** RFC 3339. */
  sentAt: string;
  root: ContentPart;
  bodyValues: Record<string, string>;
};

const CRLF = "\r\n";
const FOLD = `${CRLF} `;
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
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

/** RFC 2047 B-words, ≤ 45 UTF-8 octets each so every word stays ≤ 75 chars. */
function encodedWords(value: string): string {
  const words: string[] = [];
  let chunk = "";
  let chunkBytes = 0;
  for (const char of value) {
    const size = utf8Bytes(char).byteLength;
    if (chunkBytes + size > 45 && chunk) {
      words.push(chunk);
      chunk = "";
      chunkBytes = 0;
    }
    chunk += char;
    chunkBytes += size;
  }
  if (chunk) words.push(chunk);
  return words
    .map((word) => `=?UTF-8?B?${toBase64(utf8Bytes(word))}?=`)
    .join(FOLD);
}

export function headerText(value: string): string {
  return PRINTABLE_ASCII.test(value) ? value : encodedWords(value);
}

function mailbox(address: ContentAddress): string {
  if (!address.name) return address.email;
  const name = PRINTABLE_ASCII.test(address.name)
    ? encodeDisplayName(address.name)
    : encodedWords(address.name);
  return `${name} <${address.email}>`;
}

export function addressList(addresses: ContentAddress[]): string {
  return addresses.map(mailbox).join(`,${FOLD}`);
}

function idList(ids: string[]): string {
  return ids.map((id) => `<${id}>`).join(FOLD);
}

export function rfc5322Date(sentAt: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.exec(
      sentAt,
    );
  if (!match) throw new Error(`invalid sentAt: ${sentAt}`);
  const [, year, month, day, hour, minute, second, zone] = match;
  const weekday =
    DAYS[
      new Date(
        Date.UTC(Number(year), Number(month) - 1, Number(day)),
      ).getUTCDay()
    ];
  const offset = zone.toUpperCase() === "Z" ? "+0000" : zone.replace(":", "");
  return `${weekday}, ${Number(day)} ${MONTHS[Number(month) - 1]} ${year} ${hour}:${minute}:${second} ${offset}`;
}

function wrapBase64(bytes: Uint8Array): string {
  const encoded = toBase64(bytes);
  const lines: string[] = [];
  for (let start = 0; start < encoded.length; start += 76) {
    lines.push(encoded.slice(start, start + 76));
  }
  return lines.join(CRLF);
}

function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function parameter(key: string, value: string): string {
  if (PRINTABLE_ASCII.test(value)) {
    return `${key}="${value.replace(/[\\"]/g, "\\$&")}"`;
  }
  return `${key}*=UTF-8''${encodeRfc5987(value)}`;
}

type RenderState = {
  contentId: string;
  multiparts: number;
  bodyValues: Record<string, string>;
  attachmentBytes: Map<string, Uint8Array>;
};

function leafHeaders(leaf: ContentLeaf): string[] {
  let contentType = leaf.type;
  if (leaf.charset) contentType += `; charset=${leaf.charset}`;
  if (leaf.name && !leaf.disposition) {
    contentType += `; ${parameter("name", leaf.name)}`;
  }
  const headers = [
    `Content-Type: ${contentType}`,
    "Content-Transfer-Encoding: base64",
  ];
  if (leaf.disposition) {
    headers.push(
      `Content-Disposition: ${leaf.disposition}${leaf.name ? `; ${parameter("filename", leaf.name)}` : ""}`,
    );
  }
  if (leaf.cid) headers.push(`Content-ID: <${leaf.cid}>`);
  return headers;
}

function renderPart(part: ContentPart, state: RenderState): string {
  if (isMultipart(part)) {
    const boundary = `=_saasmail_${state.contentId}_${state.multiparts}`;
    state.multiparts += 1;
    const lines = [`Content-Type: ${part.type}; boundary="${boundary}"`, ""];
    for (const sub of part.subParts) {
      lines.push(`--${boundary}`, renderPart(sub, state));
    }
    lines.push(`--${boundary}--`);
    return lines.join(CRLF);
  }
  const leaf = part as ContentLeaf;
  const bytes =
    leaf.r2Key === null
      ? utf8Bytes(toCrlf(state.bodyValues[leaf.partId] ?? ""))
      : state.attachmentBytes.get(leaf.partId);
  if (!bytes) throw new Error(`missing bytes for part ${leaf.partId}`);
  return [...leafHeaders(leaf), "", wrapBase64(bytes)].join(CRLF);
}

export function buildRawMessage(
  input: RawMessageInput,
  attachmentBytes: Map<string, Uint8Array>,
): Uint8Array {
  const headers = [
    `Date: ${rfc5322Date(input.sentAt)}`,
    `From: ${mailbox(input.from)}`,
  ];
  if (input.to.length > 0) headers.push(`To: ${addressList(input.to)}`);
  if (input.cc.length > 0) headers.push(`Cc: ${addressList(input.cc)}`);
  if (input.replyTo && input.replyTo.length > 0) {
    headers.push(`Reply-To: ${addressList(input.replyTo)}`);
  }
  headers.push(`Subject: ${headerText(input.subject)}`);
  headers.push(`Message-ID: <${input.messageId}>`);
  if (input.inReplyTo && input.inReplyTo.length > 0) {
    headers.push(`In-Reply-To: ${idList(input.inReplyTo)}`);
  }
  if (input.references && input.references.length > 0) {
    headers.push(`References: ${idList(input.references)}`);
  }
  headers.push("MIME-Version: 1.0");

  const body = renderPart(input.root, {
    contentId: input.contentId,
    multiparts: 0,
    bodyValues: input.bodyValues,
    attachmentBytes,
  });
  return utf8Bytes(`${headers.join(CRLF)}${CRLF}${body}${CRLF}`);
}
