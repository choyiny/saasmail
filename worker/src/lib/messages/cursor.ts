import type { MessageKind } from "./types";

export interface MessageCursorV1 {
  v: 1;
  occurredAt: number;
  id: string;
  kind: MessageKind;
}

export class InvalidCursorError extends Error {
  constructor(message = "Invalid message cursor") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new InvalidCursorError();
  }

  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);

  let binary: string;
  try {
    binary = atob(base64 + padding);
  } catch {
    throw new InvalidCursorError();
  }

  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  try {
    return new TextDecoder().decode(bytes);
  } catch {
    throw new InvalidCursorError();
  }
}

export function encodeCursor(cursor: MessageCursorV1): string {
  return toBase64Url(JSON.stringify(cursor));
}

export function decodeCursor(value: string): MessageCursorV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch (error) {
    if (error instanceof InvalidCursorError) throw error;
    throw new InvalidCursorError();
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { v?: unknown }).v !== 1 ||
    typeof (parsed as { occurredAt?: unknown }).occurredAt !== "number" ||
    !Number.isFinite((parsed as { occurredAt: number }).occurredAt) ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    (parsed as { id: string }).id.length === 0 ||
    !["received", "sent"].includes(
      String((parsed as { kind?: unknown }).kind ?? ""),
    )
  ) {
    throw new InvalidCursorError();
  }

  return parsed as MessageCursorV1;
}
