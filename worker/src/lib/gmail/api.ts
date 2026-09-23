const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

export class GmailApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GmailApiError";
  }
}

/** Parse defensively: an outage can return HTML, and JSON.parse would throw. */
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function classify(status: number, isHistory: boolean): string {
  if (status === 404 && isHistory) return "history_gone";
  if (status === 429) return "rate_limited";
  return `http_${status}`;
}

/**
 * One message added, tagged with the id of the history record that added it.
 *
 * The record id — Gmail's "mailbox sequence ID" — is the only safe cursor for
 * a partially-processed run. A Message's own `historyId` is documented as "the
 * ID of the LAST history record that modified this message", so any later
 * touch (a read, a label, a filter) rewrites it upward and it can sort past
 * messages this run has not seen yet. Resuming from that would skip mail.
 */
export type AddedMessage = {
  messageId: string;
  /** The enclosing History record's `id`, ascending and tied to the ADD. */
  historyId: string;
};

export async function listHistory(
  accessToken: string,
  opts: { startHistoryId: string; pageToken?: string },
): Promise<{
  added: AddedMessage[];
  nextPageToken: string | null;
  historyId: string | null;
}> {
  const url = new URL(`${BASE}/history`);
  url.searchParams.set("startHistoryId", opts.startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  if (opts.pageToken) url.searchParams.set("pageToken", opts.pageToken);

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    // A 404 here specifically means startHistoryId is older than Gmail's
    // retention (about a week) — the caller must re-seed, not retry.
    throw new GmailApiError(
      res.status,
      classify(res.status, true),
      `Gmail history.list returned ${res.status}`,
    );
  }

  const payload = (await readJson(res)) ?? {};
  const added: AddedMessage[] = [];
  const history = payload.history ?? [];

  // Both fields below are required by Gmail's schema, so neither branch should
  // ever fire. They throw rather than skip because skipping would be silent
  // mail loss: a dropped entry leaves the enclosing record looking complete,
  // the cursor advances past it, and the message is never fetched again.
  // Stalling loudly on an impossible payload is the cheaper mistake.
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    const recordId = entry?.id != null ? String(entry.id) : null;
    if (!recordId) {
      throw new GmailApiError(
        res.status,
        "malformed_history",
        `Gmail history.list returned a record with no id at index ${i}; refusing to continue rather than skip the mail it added.`,
      );
    }
    for (const item of entry.messagesAdded ?? []) {
      const id = item?.message?.id;
      if (typeof id !== "string") {
        throw new GmailApiError(
          res.status,
          "malformed_history",
          `Gmail history.list returned a messagesAdded entry with no message id in record ${recordId}; refusing to continue rather than advance the cursor past it.`,
        );
      }
      added.push({ messageId: id, historyId: recordId });
    }
  }

  return {
    added,
    nextPageToken: payload.nextPageToken ?? null,
    historyId: payload.historyId != null ? String(payload.historyId) : null,
  };
}

/**
 * Every address this account may put in a From: header — its own mailbox plus
 * each verified "Send mail as" alias — lowercased and trimmed so callers can
 * compare against a stored address without re-normalising.
 *
 * Mapping an inbox to an account that cannot send as it produces a mapping
 * that only fails when a real reply goes out, so the mapping route checks this
 * up front. The thrown message never carries the token: an error from here is
 * shown to an admin and written to logs.
 */
export async function listSendAs(accessToken: string): Promise<string[]> {
  const res = await fetch(new URL(`${BASE}/settings/sendAs`), {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new GmailApiError(
      res.status,
      classify(res.status, false),
      `Gmail settings.sendAs.list returned ${res.status}`,
    );
  }

  const payload = (await readJson(res)) ?? {};
  const entries = Array.isArray(payload.sendAs) ? payload.sendAs : [];
  const addresses: string[] = [];
  for (const entry of entries) {
    const address = entry?.sendAsEmail;
    if (typeof address !== "string") continue;
    const normalized = address.trim().toLowerCase();
    if (normalized) addresses.push(normalized);
  }
  return addresses;
}

function base64UrlToArrayBuffer(b64url: string): ArrayBuffer {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Fetch one message as raw RFC822 bytes — the same shape Cloudflare's Email
 * Worker receives, which is what lets both sources share one parser.
 *
 * Returns null on 404: a message deleted between the history page and this
 * fetch is ordinary, not a failure.
 */
export async function getMessage(
  accessToken: string,
  id: string,
): Promise<{ raw: ArrayBuffer; labelIds: string[]; threadId: string } | null> {
  const url = new URL(`${BASE}/messages/${encodeURIComponent(id)}`);
  url.searchParams.set("format", "raw");

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    throw new GmailApiError(
      res.status,
      classify(res.status, false),
      `Gmail messages.get returned ${res.status}`,
    );
  }

  const payload = (await readJson(res)) ?? {};
  return {
    raw: base64UrlToArrayBuffer(payload.raw ?? ""),
    labelIds: Array.isArray(payload.labelIds) ? payload.labelIds : [],
    threadId: typeof payload.threadId === "string" ? payload.threadId : "",
  };
}
