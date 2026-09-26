import { sha256 } from "@noble/hashes/sha2.js";
import type { MessageRef } from "../lib/messages/types";
import type { SystemMailboxRole } from "./constants";

/**
 * Public JMAP ids (RFC 8620 §1.2: 1-255 octets of A-Za-z0-9-_).
 * Internal refs never leave the JMAP layer; everything a client sees is
 * produced here. Version 2 = the id and account reset of the EmailSubmission
 * work (see docs/jmap.md). Uppercase type letters carry a raw payload that is
 * already safe; lowercase letters carry base64url or a SHA-256 digest.
 */
export const JMAP_ID_FORMAT_VERSION = 2;
export const JMAP_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

const SAFE = /^[A-Za-z0-9_-]+$/;
const MAX_ID = 255;

function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function fromBase64url(value: string): string | null {
  if (!SAFE.test(value)) return null;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function utf8(value: string): string {
  return toBase64url(new TextEncoder().encode(value));
}

export function sha256Base64url(value: string): string {
  return toBase64url(sha256(new TextEncoder().encode(value)));
}

/** `upper + payload` when safe and short enough, else `lower + base64url`. */
function reversible(
  upper: string,
  lower: string,
  payload: string,
): string | null {
  if (SAFE.test(payload) && upper.length + payload.length <= MAX_ID) {
    return upper + payload;
  }
  const encoded = lower + utf8(payload);
  return encoded.length <= MAX_ID ? encoded : null;
}

function decodeReversible(
  id: string,
  upper: string,
  lower: string,
): string | null {
  if (id.length < 2) return null;
  if (id.startsWith(upper)) return SAFE.test(id.slice(1)) ? id.slice(1) : null;
  if (id.startsWith(lower)) return fromBase64url(id.slice(1));
  return null;
}

export function publicAccountId(userId: string): string {
  return `a${sha256Base64url(`jmap-account-v2:${userId}`)}`;
}

export function publicEmailId(ref: MessageRef): string {
  const [upper, lower] = ref.kind === "received" ? ["R", "r"] : ["S", "s"];
  const id = reversible(upper, lower, ref.id);
  if (!id) throw new Error(`message id too long for a JMAP id: ${ref.kind}`);
  return id;
}

export function parseEmailId(id: string): MessageRef | null {
  const received = decodeReversible(id, "R", "r");
  if (received) return { kind: "received", id: received };
  const sent = decodeReversible(id, "S", "s");
  if (sent) return { kind: "sent", id: sent };
  return null;
}

export function publicSystemMailboxId(
  inbox: string,
  role: SystemMailboxRole,
): string {
  return `b${sha256Base64url(`mailbox:sys:${inbox.toLowerCase()}:${role}`)}`;
}

export function publicCustomMailboxId(id: string): string {
  if (SAFE.test(id) && id.length + 1 <= MAX_ID) return `M${id}`;
  return `m${sha256Base64url(`mailbox:mbx:${id}`)}`;
}

const THREAD_PREFIXES: [string, string][] = [
  ["p:", "Tp"],
  ["received:", "Tr"],
  ["sent:", "Ts"],
];

export function publicThreadId(internalKey: string): string {
  for (const [prefix, letters] of THREAD_PREFIXES) {
    if (internalKey.startsWith(prefix)) {
      const rest = internalKey.slice(prefix.length);
      if (SAFE.test(rest) && letters.length + rest.length <= MAX_ID) {
        return letters + rest;
      }
    }
  }
  if (SAFE.test(internalKey) && internalKey.length + 2 <= MAX_ID) {
    return `Tc${internalKey}`;
  }
  const encoded = `t${utf8(internalKey)}`;
  if (encoded.length <= MAX_ID) return encoded;
  return `x${sha256Base64url(`thread:${internalKey}`)}`;
}

export function parseThreadId(id: string): string | null {
  if (id.startsWith("T") && id.length >= 3) {
    const kind = id[1];
    const rest = id.slice(2);
    if (!SAFE.test(rest)) return null;
    if (kind === "p") return `p:${rest}`;
    if (kind === "r") return `received:${rest}`;
    if (kind === "s") return `sent:${rest}`;
    if (kind === "c") return rest;
    return null;
  }
  if (id.startsWith("t") && id.length >= 2) return fromBase64url(id.slice(1));
  return null;
}

export function publicIdentityId(email: string): string {
  return `i${sha256Base64url(`identity:${email.toLowerCase()}`)}`;
}

export function publicAttachmentBlobId(attachmentId: string): string {
  const id = reversible("A", "Q", attachmentId);
  if (!id) throw new Error("attachment id too long for a JMAP id");
  return id;
}

export function parseAttachmentBlobId(id: string): string | null {
  return decodeReversible(id, "A", "Q");
}

export function publicBodyPartBlobId(
  publicEmailId: string,
  part: "text" | "html",
): string {
  return `P${publicEmailId}_${part}`;
}

export function parseBodyPartBlobId(
  id: string,
): { emailId: string; part: "text" | "html" } | null {
  const match = /^P(.+)_(text|html)$/.exec(id);
  if (!match || !parseEmailId(match[1])) return null;
  return { emailId: match[1], part: match[2] as "text" | "html" };
}

/** Change-log rows store internal ids (SQL triggers); encode them on the way out. */
export function publicIdForChangeObject(objectId: string): string {
  if (objectId.startsWith("received:")) {
    return publicEmailId({ kind: "received", id: objectId.slice(9) });
  }
  if (objectId.startsWith("sent:")) {
    return publicEmailId({ kind: "sent", id: objectId.slice(5) });
  }
  if (objectId.startsWith("mbx:")) {
    return publicCustomMailboxId(objectId.slice(4));
  }
  return objectId;
}
