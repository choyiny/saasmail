/**
 * The slice of Microsoft Graph the Outlook integration uses: per-folder
 * message delta for the live sync, a date-window listing for the one-year
 * import, a message's MIME, and sendMail.
 *
 * Every request asks for IMMUTABLE ids (`Prefer: IdType="ImmutableId"`).
 * Graph's default ids change when a message moves between folders — a reply
 * moving from Drafts to Sent Items, or mail filed into Archive — and these
 * ids are stored as dedupe keys, so they must not.
 */

const GRAPH = "https://graph.microsoft.com/v1.0";

/** Messages per Graph page. Delta and listings both honour this. */
export const GRAPH_PAGE_SIZE = 50;

export class GraphApiError extends Error {
  constructor(
    public status: number,
    /**
     * `sync_state_gone` (a delta link Graph no longer honours),
     * `rate_limited`, or `http_<status>`. A code, never free text.
     */
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function classify(status: number, body: any): string {
  const code = String(body?.error?.code ?? "");
  // Graph answers an expired or reset delta token with 410 Gone, or a 400
  // whose code names the sync state.
  if (status === 410 || /syncstate|resyncrequired/i.test(code)) {
    return "sync_state_gone";
  }
  if (status === 429) return "rate_limited";
  return `http_${status}`;
}

function headers(accessToken: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Prefer: `IdType="ImmutableId", odata.maxpagesize=${GRAPH_PAGE_SIZE}`,
    ...extra,
  };
}

async function getJson(accessToken: string, url: string, what: string) {
  const res = await fetch(url, { headers: headers(accessToken) });
  if (!res.ok) {
    const body = await readJson(res);
    throw new GraphApiError(
      res.status,
      classify(res.status, body),
      `Graph ${what} returned ${res.status}`,
    );
  }
  return (await readJson(res)) ?? {};
}

function seconds(iso: unknown): number | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function iso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The folders the sync reads, by Graph's well-known names. */
export type SyncFolder = "inbox" | "sentitems";

/**
 * The first URL of a delta round over a folder, limited to mail received at
 * or after `sinceSeconds`. A first sync and a re-seed after an expired delta
 * link both start here, so only mail from that point on comes in.
 */
export function initialDeltaUrl(
  folder: SyncFolder,
  sinceSeconds: number,
): string {
  const url = new URL(`${GRAPH}/me/mailFolders/${folder}/messages/delta`);
  url.searchParams.set("$select", "id,receivedDateTime,isDraft");
  url.searchParams.set("$filter", `receivedDateTime ge ${iso(sinceSeconds)}`);
  return url.toString();
}

export type DeltaItem = {
  id: string;
  /** Deleted or moved out of the folder since the last round. */
  removed: boolean;
  isDraft: boolean;
  receivedAt: number | null;
};

/**
 * One page of a delta round. Exactly one of `nextLink` (more of this round)
 * and `deltaLink` (round complete; the cursor for the next one) is set.
 *
 * Throws GraphApiError, with code `sync_state_gone` when Graph no longer
 * honours the link.
 */
export async function deltaPage(
  accessToken: string,
  url: string,
): Promise<{
  items: DeltaItem[];
  nextLink: string | null;
  deltaLink: string | null;
}> {
  const payload = await getJson(accessToken, url, "messages/delta");
  const items: DeltaItem[] = [];
  for (const raw of payload.value ?? []) {
    if (typeof raw?.id !== "string") continue;
    items.push({
      id: raw.id,
      removed: raw["@removed"] != null,
      isDraft: raw.isDraft === true,
      receivedAt: seconds(raw.receivedDateTime),
    });
  }
  const nextLink =
    typeof payload["@odata.nextLink"] === "string"
      ? payload["@odata.nextLink"]
      : null;
  const deltaLink =
    typeof payload["@odata.deltaLink"] === "string"
      ? payload["@odata.deltaLink"]
      : null;
  if (!nextLink && !deltaLink) {
    throw new GraphApiError(
      200,
      "malformed_delta",
      "Graph messages/delta returned neither a nextLink nor a deltaLink; refusing to lose the cursor.",
    );
  }
  return { items, nextLink, deltaLink };
}

/**
 * The first URL of the one-year import's listing: every folder's mail
 * received in `[since, until)`, newest first.
 */
export function backfillListUrl(since: number, until: number): string {
  const url = new URL(`${GRAPH}/me/messages`);
  url.searchParams.set("$select", "id,receivedDateTime,parentFolderId,isDraft");
  url.searchParams.set(
    "$filter",
    `receivedDateTime ge ${iso(since)} and receivedDateTime lt ${iso(until)}`,
  );
  url.searchParams.set("$orderby", "receivedDateTime desc");
  url.searchParams.set("$top", String(GRAPH_PAGE_SIZE));
  return url.toString();
}

export type ListedMessage = {
  id: string;
  parentFolderId: string | null;
  isDraft: boolean;
  receivedAt: number | null;
};

/** One page of a `/me/messages` listing. */
export async function listPage(
  accessToken: string,
  url: string,
): Promise<{ items: ListedMessage[]; nextLink: string | null }> {
  const payload = await getJson(accessToken, url, "messages");
  const items: ListedMessage[] = [];
  for (const raw of payload.value ?? []) {
    if (typeof raw?.id !== "string") continue;
    items.push({
      id: raw.id,
      parentFolderId:
        typeof raw.parentFolderId === "string" ? raw.parentFolderId : null,
      isDraft: raw.isDraft === true,
      receivedAt: seconds(raw.receivedDateTime),
    });
  }
  return {
    items,
    nextLink:
      typeof payload["@odata.nextLink"] === "string"
        ? payload["@odata.nextLink"]
        : null,
  };
}

/** Ids of the folders the import needs to tell apart. */
export type FolderIds = {
  sentitems: string;
  junkemail: string;
  deleteditems: string;
  drafts: string;
};

export async function wellKnownFolderIds(
  accessToken: string,
): Promise<FolderIds> {
  const names = ["sentitems", "junkemail", "deleteditems", "drafts"] as const;
  const ids = await Promise.all(
    names.map(async (name) => {
      const payload = await getJson(
        accessToken,
        `${GRAPH}/me/mailFolders/${name}?$select=id`,
        `mailFolders/${name}`,
      );
      if (typeof payload.id !== "string") {
        throw new GraphApiError(
          200,
          "malformed_folder",
          `Graph mailFolders/${name} returned no id`,
        );
      }
      return payload.id as string;
    }),
  );
  return {
    sentitems: ids[0],
    junkemail: ids[1],
    deleteditems: ids[2],
    drafts: ids[3],
  };
}

/** A message's MIME, or null when it has been deleted since it was listed. */
export async function getMime(
  accessToken: string,
  id: string,
): Promise<ArrayBuffer | null> {
  const res = await fetch(
    `${GRAPH}/me/messages/${encodeURIComponent(id)}/$value`,
    { headers: headers(accessToken) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await readJson(res);
    throw new GraphApiError(
      res.status,
      classify(res.status, body),
      `Graph messages/$value returned ${res.status}`,
    );
  }
  return res.arrayBuffer();
}

/**
 * Send a MIME message as the signed-in mailbox. Graph files it in Sent Items
 * and answers 202 with no body — there is no message id to keep.
 */
export async function sendMime(
  accessToken: string,
  mimeBase64: string,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  return fetchFn(`${GRAPH}/me/sendMail`, {
    method: "POST",
    headers: headers(accessToken, { "Content-Type": "text/plain" }),
    body: mimeBase64,
  });
}
