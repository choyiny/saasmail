import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { asyncJobs, type AsyncJob } from "../../db/async-jobs.schema";
import { users } from "../../db/auth.schema";
import { emails } from "../../db/emails.schema";
import { mailboxes } from "../../db/mailboxes.schema";
import { senderIdentities } from "../../db/sender-identities.schema";
import { AUDIT_ACTIONS } from "../audit/events";
import { runWithAudit, type AuditActor } from "../audit/context";
import { recordAudit } from "../audit/record";
import { parseRawEmail, type ParsedEmail } from "../email-parser";
import { domainsOf, storeReceivedMessage } from "../inbound/store-received";
import { storeSentMessage } from "../inbound/store-sent";
import { isDemoMode } from "../is-dev";
import {
  IDLE_SECONDS,
  SliceBusyError,
  changesOf,
  claimSlice,
  paramsOf,
  recoverIdleJob,
  releaseClaim,
  stillClaimed,
  type SliceState,
} from "../jobs/slices";
import {
  createMailbox,
  setMailboxMembership,
  setMailboxState,
  setUserState,
} from "../messages/state";
import type { MessageRef } from "../messages/types";
import { notifyMailRefresh } from "../triage/ai-file";
import { mboxStart, readMessages } from "./mbox-reader";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

/** A queued slice of a mail import. */
export type MailImportMessage = {
  type: "mail_import";
  jobId: string;
  slice: number;
};

export type ImportDirection = "strict" | "all_received";

export interface MailImportRequest {
  inbox: string;
  filename: string;
  /** Bytes. */
  size: number;
  direction: ImportDirection;
  createFoldersFromLabels: boolean;
}

/** The job's `params`. */
export interface ImportParams extends SliceState {
  inbox: string;
  filename: string;
  size: number;
  direction: ImportDirection;
  createFoldersFromLabels: boolean;
  /** The browser's multipart upload, until it completes. */
  uploadId: string | null;
  parts: { partNumber: number; etag: string }[];
  /** Set by the first slice: an mbox, or one message (.eml). */
  format: "mbox" | "eml" | null;
  /** The uploaded file is gone (24 hours after the import ended). */
  sourceDeleted?: boolean;
  /** Messages skipped because every attempt at them failed. */
  stuckSkips?: number;
}

/** The browser uploads the file in parts of this size (the last smaller). */
export const IMPORT_PART_BYTES = 32 * 1024 * 1024;
/** The largest file an import takes. */
export const MAX_IMPORT_BYTES = 5 * 1000 * 1000 * 1000;
/**
 * How a slice reads and when it stops. A slice holds one window, or one
 * message read on its own, at a time; `maxMessage` keeps a message and its
 * parse inside the Worker's 128 MB. `sliceOps` is a budget of D1 and R2 calls
 * (about six per message plus two per attachment), well inside one
 * invocation's limits. Mutable for tests.
 */
export const IMPORT_LIMITS = {
  window: 8 * 1024 * 1024,
  maxMessage: 32 * 1024 * 1024,
  sliceMessages: 200,
  sliceOps: 450,
  sliceMs: 20_000,
};
/** Messages skipped because they kept failing, before the import fails. */
const MAX_STUCK_SKIPS = 10;
/** Notes kept in `error_summary`. */
const MAX_NOTES = 50;
/** The uploaded file is kept this long after the import ends. */
const SOURCE_TTL_SECONDS = 24 * 60 * 60;
/** An upload nobody finished is given up after this. */
const UPLOAD_TTL_SECONDS = 24 * 60 * 60;

const sourceKey = (jobId: string) => `imports/${jobId}/source`;

type Note = { row: number; reason: string };

export class ImportRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function importParams(job: AsyncJob): ImportParams {
  return paramsOf<ImportParams>(job);
}

/** The parts a file of `size` bytes is uploaded in. */
export function expectedParts(size: number): number {
  return Math.max(1, Math.ceil(size / IMPORT_PART_BYTES));
}

function notesOf(job: AsyncJob): Note[] {
  if (!job.errorSummary) return [];
  try {
    return JSON.parse(job.errorSummary) as Note[];
  } catch {
    return [];
  }
}

/** Starts an import: the job row, waiting for its upload. */
export async function startMailImport(
  db: Db,
  env: CloudflareBindings,
  input: MailImportRequest & { userId: string },
): Promise<AsyncJob> {
  const id = nanoid();
  const key = sourceKey(id);
  const upload = await env.R2.createMultipartUpload(key);
  const now = Math.floor(Date.now() / 1000);
  const params: ImportParams = {
    inbox: input.inbox.trim().toLowerCase(),
    filename: input.filename.slice(0, 200),
    size: input.size,
    direction: input.direction,
    createFoldersFromLabels: input.createFoldersFromLabels,
    uploadId: upload.uploadId,
    parts: [],
    format: null,
    slice: 0,
    lease: null,
    leaseUntil: null,
  };
  const job: AsyncJob = {
    id,
    jobType: "mail_import",
    refId: params.inbox,
    status: "uploading",
    cursor: "0",
    storageKey: key,
    totalRows: null,
    processedRows: 0,
    importedCount: 0,
    skippedCount: 0,
    errorSummary: null,
    params: JSON.stringify(params),
    requestedBy: input.userId,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(asyncJobs).values(job);
  return job;
}

/** The job as it is now. */
export async function importJobById(
  db: Db,
  jobId: string,
): Promise<AsyncJob | null> {
  const [job] = await db
    .select()
    .from(asyncJobs)
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.jobType, "mail_import")))
    .limit(1);
  return job ?? null;
}

/**
 * One part of the upload. Every part but the last is exactly
 * IMPORT_PART_BYTES, and the parts add up to the size given at the start. A
 * part sent again replaces the first.
 */
export async function uploadImportPart(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  partNumber: number,
  bytes: Uint8Array,
): Promise<void> {
  const params = importParams(job);
  if (job.status !== "uploading" || !params.uploadId) {
    throw new ImportRequestError(
      "This import is not uploading",
      "NOT_UPLOADING",
    );
  }
  const parts = expectedParts(params.size);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > parts) {
    throw new ImportRequestError(
      `Part ${partNumber} is out of range (1–${parts})`,
      "INVALID_PART",
    );
  }
  const expected =
    partNumber < parts
      ? IMPORT_PART_BYTES
      : params.size - (parts - 1) * IMPORT_PART_BYTES;
  if (bytes.length !== expected) {
    throw new ImportRequestError(
      `Part ${partNumber} must be ${expected} bytes`,
      "INVALID_PART_SIZE",
    );
  }
  const part = await env.R2.resumeMultipartUpload(
    job.storageKey!,
    params.uploadId,
  ).uploadPart(partNumber, bytes);

  // Record the etag; parts may arrive together, so retry on a change.
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = attempt === 0 ? job : await importJobById(db, job.id);
    if (!current || current.status !== "uploading") return;
    const now = importParams(current);
    const recorded = [
      ...now.parts.filter((entry) => entry.partNumber !== partNumber),
      { partNumber, etag: part.etag },
    ].sort((a, b) => a.partNumber - b.partNumber);
    const result = await db
      .update(asyncJobs)
      .set({
        params: JSON.stringify({ ...now, parts: recorded }),
        updatedAt: Math.floor(Date.now() / 1000),
      })
      .where(
        and(
          eq(asyncJobs.id, job.id),
          eq(asyncJobs.params, current.params ?? ""),
        ),
      );
    if (changesOf(result) === 1) return;
  }
  throw new Error(`import ${job.id}: part ${partNumber} not recorded`);
}

/**
 * The upload is whole: completes it and starts the import. The caller
 * queues slice 0 (or runs it inline).
 */
export async function completeImportUpload(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
): Promise<AsyncJob> {
  const params = importParams(job);
  if (job.status !== "uploading" || !params.uploadId) {
    throw new ImportRequestError(
      "This import is not uploading",
      "NOT_UPLOADING",
    );
  }
  const parts = expectedParts(params.size);
  const missing = Array.from({ length: parts }, (_, i) => i + 1).filter(
    (n) => !params.parts.some((part) => part.partNumber === n),
  );
  if (missing.length > 0) {
    throw new ImportRequestError(
      `Parts missing: ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? "…" : ""}`,
      "PARTS_MISSING",
    );
  }
  const object = await env.R2.resumeMultipartUpload(
    job.storageKey!,
    params.uploadId,
  ).complete(params.parts);
  const started: ImportParams = {
    ...params,
    size: object.size,
    uploadId: null,
  };
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .update(asyncJobs)
    .set({
      status: "running",
      params: JSON.stringify(started),
      updatedAt: now,
    })
    .where(
      and(
        eq(asyncJobs.id, job.id),
        eq(asyncJobs.status, "uploading"),
        eq(asyncJobs.params, job.params ?? ""),
      ),
    );
  if (changesOf(result) !== 1) {
    throw new ImportRequestError("This import changed meanwhile", "CONFLICT");
  }
  await recordAudit(db, {
    action: AUDIT_ACTIONS.importStarted,
    targetType: "import",
    targetId: job.id,
    inbox: params.inbox,
    summary: `Started importing ${params.filename} into ${params.inbox}`,
    details: {
      filename: params.filename,
      bytes: object.size,
      direction: params.direction,
      createFoldersFromLabels: params.createFoldersFromLabels,
    },
  });
  return (await importJobById(db, job.id))!;
}

/** `<import-<sha256>@saasmail.local>`: re-importing the same file finds it. */
async function syntheticMessageId(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return `<import-${hex}@saasmail.local>`;
}

/** RFC 2047 B and Q words in a label, decoded. */
function decodeWords(value: string): string {
  return value.replace(
    /=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g,
    (word, charset: string, encoding: string, text: string) => {
      try {
        const binary =
          encoding.toUpperCase() === "B"
            ? atob(text)
            : text
                .replace(/_/g, " ")
                .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
                  String.fromCharCode(parseInt(hex, 16)),
                );
        return new TextDecoder(charset).decode(
          Uint8Array.from(binary, (c) => c.charCodeAt(0)),
        );
      } catch {
        return word;
      }
    },
  );
}

/** A labels header (`X-Gmail-Labels`, `X-Saasmail-Labels`) as a list. */
export function parseLabels(value: string): string[] {
  const labels: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quoted && char === "\\" && i + 1 < value.length) {
      current += value[++i];
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      labels.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  labels.push(current);
  return labels
    .map((label) => decodeWords(label.trim()).trim())
    .filter((label) => label !== "");
}

/** Gmail's and saasmail's own labels that are not folders. */
const SYSTEM_LABELS = new Set([
  "inbox",
  "sent",
  "spam",
  "junk",
  "trash",
  "starred",
  "important",
  "unread",
  "opened",
  "chat",
  "draft",
  "drafts",
  "archived",
  "all mail",
]);

export interface LabelState {
  archived: boolean;
  spam: boolean;
  trashed: boolean;
  starred: boolean;
  folders: string[];
}

const utf8 = new TextDecoder();

/**
 * The labels an exporter wrote above the message's own headers: the block of
 * `X-GM-*`, `X-Gmail-*` and `X-Saasmail-*` lines Gmail Takeout and saasmail's
 * export put first. A labels header further down was written by the sender
 * and is never trusted. saasmail's own wins over Gmail's.
 */
export function exporterLabels(message: Uint8Array): string | undefined {
  const head = utf8.decode(message.subarray(0, 65_536));
  const found: Record<string, string> = {};
  let current: string | null = null;
  for (const line of head.split(/\r?\n/)) {
    if (line === "") break;
    if (/^[ \t]/.test(line)) {
      if (current) found[current] += ` ${line.trim()}`;
      continue;
    }
    const match = /^([A-Za-z0-9-]+):[ \t]?(.*)$/.exec(line);
    if (!match) break;
    const name = match[1].toLowerCase();
    if (!/^x-(gm|gmail|saasmail)-/.test(name)) break;
    current = name in found ? null : name;
    if (current) found[current] = match[2];
  }
  return found["x-saasmail-labels"] ?? found["x-gmail-labels"];
}

/** A draft (Gmail's `Draft` label): never sent, so never imported. */
export function isDraft(header: string | undefined): boolean {
  if (header === undefined) return false;
  return parseLabels(header).some((label) =>
    ["draft", "drafts"].includes(label.toLowerCase()),
  );
}

/**
 * What a message's labels say about its state: Spam/Junk → junk, Trash →
 * trash, no Inbox (and not Sent) → archived, Starred → starred, other
 * labels → custom folders. Without a labels header: Inbox.
 */
export function labelState(
  header: string | undefined,
  direction: "received" | "sent",
): LabelState {
  if (header === undefined) {
    return {
      archived: false,
      spam: false,
      trashed: false,
      starred: false,
      folders: [],
    };
  }
  const labels = parseLabels(header);
  const lower = new Set(labels.map((label) => label.toLowerCase()));
  const trashed = lower.has("trash");
  const spam =
    direction === "received" &&
    !trashed &&
    (lower.has("spam") || lower.has("junk"));
  return {
    trashed,
    spam,
    archived:
      direction === "received" &&
      !trashed &&
      !spam &&
      !lower.has("inbox") &&
      !lower.has("sent"),
    starred: lower.has("starred"),
    folders: labels.filter((label) => {
      const key = label.toLowerCase();
      return !SYSTEM_LABELS.has(key) && !key.startsWith("category ");
    }),
  };
}

/** Whether a message's headers address it to the inbox. */
function addressedTo(parsed: ParsedEmail, inbox: string): boolean {
  return (
    [...parsed.toList, ...parsed.cc, ...parsed.bcc].some(
      (address) => address.email === inbox,
    ) || parsed.deliveredTo.includes(inbox)
  );
}

/** A label as a folder name: trimmed, at most 100 characters. */
function folderName(label: string): string {
  return label.trim().slice(0, 100).trim();
}

/** When the message happened: its Date, else the separator's, else now. */
function occurredAt(
  parsed: ParsedEmail,
  separatorDate: Date | null,
  now: number,
): number {
  const fromHeader = parsed.date ? Date.parse(parsed.date) : Number.NaN;
  const ms = Number.isFinite(fromHeader)
    ? fromHeader
    : (separatorDate?.getTime() ?? now * 1000);
  const seconds = Math.floor(ms / 1000);
  return seconds > 0 && seconds <= now + 86_400 ? seconds : now;
}

/** The state labels ask for, gathered over a slice and applied together. */
class LabelBatch {
  archived: MessageRef[] = [];
  spam: MessageRef[] = [];
  trashed: MessageRef[] = [];
  starred: MessageRef[] = [];
  folders = new Map<string, MessageRef[]>();

  add(ref: MessageRef, state: LabelState, createFolders: boolean) {
    if (state.archived) this.archived.push(ref);
    if (state.spam) this.spam.push(ref);
    if (state.trashed) this.trashed.push(ref);
    if (state.starred) this.starred.push(ref);
    if (createFolders) {
      for (const label of state.folders.slice(0, 20)) {
        const name = folderName(label);
        if (!name) continue;
        // One folder per name, whatever its case.
        const key =
          [...this.folders.keys()].find(
            (existing) => existing.toLowerCase() === name.toLowerCase(),
          ) ?? name;
        this.folders.set(key, [...(this.folders.get(key) ?? []), ref]);
      }
    }
  }

  async apply(db: Db, inbox: string, userId: string): Promise<void> {
    const allowed = { isAdmin: true as const };
    if (this.archived.length > 0) {
      await setMailboxState(db, allowed, userId, this.archived, {
        archived: true,
      });
    }
    if (this.spam.length > 0) {
      await setMailboxState(db, allowed, userId, this.spam, { spam: true });
    }
    if (this.trashed.length > 0) {
      await setMailboxState(db, allowed, userId, this.trashed, {
        trashed: true,
      });
    }
    if (this.starred.length > 0) {
      await setUserState(db, userId, this.starred, { starred: true });
    }
    for (const [name, refs] of this.folders) {
      const [existing] = await db
        .select({ id: mailboxes.id })
        .from(mailboxes)
        .where(
          and(
            eq(mailboxes.inbox, inbox),
            sql`lower(${mailboxes.name}) = lower(${name})`,
            isNull(mailboxes.parentId),
          ),
        )
        .limit(1);
      const id =
        existing?.id ??
        (await createMailbox(db, allowed, userId, { inbox, name })).id;
      await setMailboxMembership(db, allowed, userId, refs, { add: [id] });
    }
    this.archived = [];
    this.spam = [];
    this.trashed = [];
    this.starred = [];
    this.folders.clear();
  }
}

/** Whether D1 refused a row as too large, through Drizzle's wrapping. */
function tooBig(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    if (
      String((current as Error).message ?? current).includes("SQLITE_TOOBIG")
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * A message already in the inbox: received mail by Message-ID, mail the
 * inbox sent by Message-ID or, for a JMAP send (whose row keeps the
 * provider's id), by its own. `importJobId` tells a row this import stored
 * on an earlier attempt from one that was there before.
 */
async function existingMessage(
  db: Db,
  inbox: string,
  messageId: string,
  sent: boolean,
): Promise<{ id: string; importJobId: string | null } | null> {
  if (!sent) {
    const [row] = await db
      .select({ id: emails.id, importJobId: emails.importJobId })
      .from(emails)
      .where(and(eq(emails.messageId, messageId), eq(emails.recipient, inbox)))
      .limit(1);
    return row ?? null;
  }
  const bare = messageId.replace(/^<|>$/g, "");
  const [row] = await db.all<{ id: string; import_job_id: string | null }>(sql`
    SELECT se.id AS id, se.import_job_id AS import_job_id
    FROM sent_emails se
    WHERE se.from_address = ${inbox}
      AND (
        se.message_id = ${messageId}
        OR EXISTS (
          SELECT 1 FROM jmap_message_content c
          WHERE c.id = se.jmap_content_id AND c.message_id = ${bare}
        )
      )
    LIMIT 1
  `);
  return row ? { id: row.id, importJobId: row.import_job_id } : null;
}

/** Who an import acts as: its admin, on the `import` channel. */
async function importActor(db: Db, job: AsyncJob): Promise<AuditActor> {
  const [user] = job.requestedBy
    ? await db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, job.requestedBy))
        .limit(1)
    : [];
  return {
    actorType: "user",
    actorUserId: job.requestedBy,
    actorLabel: user?.email ?? "import",
    channel: "import",
  };
}

/**
 * One slice of an import: reads the file from the byte cursor, a window at
 * a time, and stores each message in it (at most 200, or 20 seconds' worth)
 * the way live mail is stored, but as read history with no rules,
 * notifications, webhooks or forwards. Returns the next slice, or null.
 * Re-running a slice is safe: a message already in the inbox is a
 * duplicate, by Message-ID (or a hash of its bytes when it has none).
 */
export async function runMailImportSlice(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
  now: () => number = Date.now,
): Promise<number | null> {
  const job = await importJobById(db, jobId);
  if (!job || job.status !== "running") return null;
  const claim = await claimSlice<ImportParams>(db, job, slice, now());
  if (claim === "stale") return null;
  if (claim === "busy") throw new SliceBusyError(jobId);
  const { params, raw } = claim;
  const actor = await importActor(db, job);
  try {
    return await runWithAudit(actor, () =>
      importSlice(db, env, job, params, raw, now),
    );
  } catch (error) {
    await releaseClaim(db, jobId, params, raw);
    throw error;
  }
}

async function importSlice(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
  params: ImportParams,
  claimedRaw: string,
  now: () => number,
): Promise<number | null> {
  const started = now();
  const nowSeconds = Math.floor(started / 1000);
  const key = job.storageKey!;
  let cursor = Number(job.cursor ?? "0");
  let format = params.format;
  if (format === null) {
    const head = await env.R2.get(key, { range: { offset: 0, length: 4096 } });
    if (!head)
      throw new Error(`import ${job.id}: the uploaded file is missing`);
    const start = mboxStart(new Uint8Array(await head.arrayBuffer()));
    format = start === -1 ? "eml" : "mbox";
    cursor = Math.max(start, 0);
  }

  const identities = await db
    .select({ email: senderIdentities.email })
    .from(senderIdentities);
  const ourDomains = domainsOf(identities.map((row) => row.email));
  let processed = 0;
  let imported = 0;
  let skipped = 0;
  const notes: Note[] = [];
  const labels = new LabelBatch();
  const userId = job.requestedBy;
  const note = (reason: string) => {
    notes.push({
      row: job.processedRows + processed,
      reason: reason.slice(0, 300),
    });
  };

  /** D1 and R2 calls this slice has made, roughly (see IMPORT_LIMITS). */
  let ops = 0;

  /** Stores one message, or counts it as skipped. */
  async function importOne(
    bytes: Uint8Array,
    separatorDate: Date | null,
  ): Promise<void> {
    processed++;
    ops += 6;
    let parsed: ParsedEmail;
    try {
      parsed = await parseRawEmail(bytes);
    } catch {
      skipped++;
      note("could not be read as a message");
      return;
    }
    const labelHeader = exporterLabels(bytes);
    const subject = parsed.subject.slice(0, 80);
    if (isDraft(labelHeader)) {
      skipped++;
      note(`a draft, never sent: ${subject}`);
      return;
    }
    parsed.messageId ??= await syntheticMessageId(bytes);
    const from = parsed.from.address.trim().toLowerCase();
    const at = occurredAt(parsed, separatorDate, nowSeconds);
    const sent = from === params.inbox;
    if (!sent && !from) {
      skipped++;
      note(`no sender: ${subject}`);
      return;
    }
    if (
      !sent &&
      params.direction === "strict" &&
      !addressedTo(parsed, params.inbox)
    ) {
      skipped++;
      note(`not addressed to ${params.inbox}: ${subject}`);
      return;
    }
    const state = labelState(labelHeader, sent ? "sent" : "received");

    // Already in the inbox: a re-import, or mail that arrived live. A row
    // this import stored on an attempt that died before saving its progress
    // still counts as imported, and still gets its labels.
    const existing = await existingMessage(
      db,
      params.inbox,
      parsed.messageId,
      sent,
    );
    if (existing) {
      if (existing.importJobId === job.id) {
        imported++;
        labels.add(
          { kind: sent ? "sent" : "received", id: existing.id },
          state,
          params.createFoldersFromLabels,
        );
      } else {
        skipped++;
      }
      return;
    }

    let ref: MessageRef;
    let dropped: number;
    ops += 2 * parsed.attachments.length;
    if (sent) {
      const stored = await storeSentMessage(db, env, {
        parsed,
        inbox: params.inbox,
        sentAt: at,
        now: nowSeconds,
        ourDomains,
        importJobId: job.id,
      });
      if (!stored) {
        skipped++;
        note(`no recipient: ${subject}`);
        return;
      }
      ref = { kind: "sent", id: stored.sentId };
      dropped = stored.droppedAttachments;
    } else {
      const stored = await storeReceivedMessage(db, env, {
        parsed,
        inbox: params.inbox,
        fromAddress: from,
        receivedAt: at,
        now: nowSeconds,
        source: "import",
        ourDomains,
        importJobId: job.id,
      });
      ref = { kind: "received", id: stored.emailId };
      dropped = stored.droppedAttachments;
    }
    imported++;
    if (dropped > 0) {
      note(
        `${dropped} ${dropped === 1 ? "attachment" : "attachments"} over the limits dropped: ${subject}`,
      );
    }
    labels.add(ref, state, params.createFoldersFromLabels);
  }

  /** Whether the slice has done its share. */
  const full = () =>
    processed >= IMPORT_LIMITS.sliceMessages ||
    ops >= IMPORT_LIMITS.sliceOps ||
    now() - started >= IMPORT_LIMITS.sliceMs;

  /** Imports one message, or skips it when it can never be stored. */
  async function importAt(message: {
    offset: number;
    end: number;
    bytes: Uint8Array;
    separatorDate: Date | null;
  }): Promise<void> {
    try {
      await importOne(message.bytes, message.separatorDate);
    } catch (error) {
      if (tooBig(error)) {
        // Too big for a row even cut down: retrying cannot help.
        skipped++;
        note("too large to store (its headers or bodies)");
        cursor = message.end;
        return;
      }
      // Keep what this slice did; the retry of this slice starts at this
      // message.
      processed--;
      await commit(message.offset, params.slice, false).catch(() => {});
      throw error;
    }
    cursor = message.end;
  }

  /**
   * Saves progress up to `at`, the offset where the next message starts:
   * the state labels asked for, counts, notes and the cursor. `next`: the
   * slice the job waits for after this (the same one when a retry should
   * continue it). `done`: the file is finished. Returns whether this run
   * still held the job.
   */
  async function commit(
    at: number,
    next: number,
    done: boolean,
  ): Promise<boolean> {
    if (userId) await labels.apply(db, params.inbox, userId);
    const allNotes = [...notesOf(job), ...notes].slice(0, MAX_NOTES);
    const nextParams: ImportParams = {
      ...params,
      format,
      slice: next,
      lease: null,
      leaseUntil: null,
    };
    const processedRows = job.processedRows + processed;
    const importedCount = job.importedCount + imported;
    const skippedCount = job.skippedCount + skipped;
    const result = await db
      .update(asyncJobs)
      .set({
        cursor: String(at),
        processedRows,
        importedCount,
        skippedCount,
        errorSummary: allNotes.length > 0 ? JSON.stringify(allNotes) : null,
        params: JSON.stringify(nextParams),
        updatedAt: Math.floor(now() / 1000),
        ...(done
          ? { status: "completed" as const, totalRows: processedRows }
          : {}),
      })
      .where(stillClaimed(job.id, claimedRaw));
    // One refresh for the slice, not one per message.
    if (imported > 0) await notifyMailRefresh(db, env, params.inbox);
    if (changesOf(result) !== 1) return false;
    if (done) {
      await recordAudit(db, {
        action: AUDIT_ACTIONS.importCompleted,
        targetType: "import",
        targetId: job.id,
        inbox: params.inbox,
        summary: `Imported ${importedCount} ${importedCount === 1 ? "message" : "messages"} into ${params.inbox}`,
        details: {
          filename: params.filename,
          imported: importedCount,
          skipped: skippedCount,
          processed: processedRows,
        },
      });
      await notifyImportDone(
        env,
        job,
        params.inbox,
        importedCount,
        skippedCount,
      );
    }
    return true;
  }

  // One message: the whole file.
  if (format === "eml") {
    if (params.size > IMPORT_LIMITS.maxMessage) {
      processed++;
      skipped++;
      note(`the message is larger than ${megabytes(IMPORT_LIMITS.maxMessage)}`);
    } else {
      const object = await env.R2.get(key);
      if (!object) {
        throw new Error(`import ${job.id}: the uploaded file is missing`);
      }
      await importAt({
        offset: 0,
        end: params.size,
        bytes: new Uint8Array(await object.arrayBuffer()),
        separatorDate: null,
      });
    }
    await commit(params.size, params.slice, true);
    return null;
  }

  while (cursor < params.size && !full()) {
    const length = Math.min(IMPORT_LIMITS.window, params.size - cursor);
    const object = await env.R2.get(key, {
      range: { offset: cursor, length },
    });
    if (!object) {
      throw new Error(`import ${job.id}: the uploaded file is missing`);
    }
    ops++;
    let read = readMessages(
      new Uint8Array(await object.arrayBuffer()),
      cursor,
      cursor + length >= params.size,
    );
    if (read.messages.length === 0) {
      // No message ends in the window. Find where the next one starts
      // without holding more than a window, then read this one alone, or
      // skip it when it is too large (or not a message).
      const atMessage = read.nextOffset === cursor;
      const end = await nextSeparator(env, key, cursor + 1, params.size);
      ops += Math.ceil((end - cursor) / IMPORT_LIMITS.window);
      if (!atMessage || end - cursor > IMPORT_LIMITS.maxMessage) {
        processed++;
        skipped++;
        note(
          atMessage
            ? `a message larger than ${megabytes(IMPORT_LIMITS.maxMessage)} was skipped`
            : "data that is not a message was skipped",
        );
        cursor = end;
        continue;
      }
      const whole = await env.R2.get(key, {
        range: { offset: cursor, length: end - cursor },
      });
      if (!whole) {
        throw new Error(`import ${job.id}: the uploaded file is missing`);
      }
      ops++;
      read = readMessages(
        new Uint8Array(await whole.arrayBuffer()),
        cursor,
        true,
      );
    }
    for (const message of read.messages) {
      if (full()) break;
      await importAt(message);
    }
  }

  const done = cursor >= params.size;
  const next = params.slice + 1;
  if (!(await commit(Math.min(cursor, params.size), next, done))) return null;
  return done ? null : next;
}

/**
 * The offset of the next message after `from`, reading a window at a time;
 * the file's size when there is none.
 */
async function nextSeparator(
  env: CloudflareBindings,
  key: string,
  from: number,
  size: number,
): Promise<number> {
  const OVERLAP = 1024;
  const decoder = new TextDecoder("latin1");
  const window = IMPORT_LIMITS.window;
  for (let at = from; at < size; at += window - OVERLAP) {
    const length = Math.min(window, size - at);
    const object = await env.R2.get(key, { range: { offset: at, length } });
    if (!object) break;
    const text = decoder.decode(await object.arrayBuffer());
    // A message starts after a blank line.
    const match = /\r?\n\r?\n(From \S+\s+.*\d{1,2}:\d{2})/.exec(text);
    if (match) return at + match.index + match[0].length - match[1].length;
    if (at + length >= size) break;
  }
  return size;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * The last attempt at a slice failed, at the message its progress stopped
 * at: skip that message with a note and let the import go on. Ten such
 * skips fail the import (something is wrong with more than one message).
 * Returns the slice to queue, or null.
 */
export async function skipStuckMessage(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  reason: string,
): Promise<number | null> {
  const job = await importJobById(db, jobId);
  if (!job || job.status !== "running") return null;
  const params = importParams(job);
  const skips = (params.stuckSkips ?? 0) + 1;
  if (params.format === null || skips > MAX_STUCK_SKIPS) {
    await failMailImport(db, jobId, reason);
    return null;
  }
  const claim = await claimSlice<ImportParams>(
    db,
    job,
    params.slice,
    Date.now(),
  );
  if (claim === "stale" || claim === "busy") return null;
  const cursor = Number(job.cursor ?? "0");
  const end =
    params.format === "eml"
      ? params.size
      : await nextSeparator(env, job.storageKey!, cursor + 1, params.size);
  const notes = [
    ...notesOf(job),
    {
      row: job.processedRows + 1,
      reason: `could not be stored and was skipped: ${reason}`.slice(0, 300),
    },
  ].slice(0, MAX_NOTES);
  const result = await db
    .update(asyncJobs)
    .set({
      cursor: String(end),
      processedRows: job.processedRows + 1,
      skippedCount: job.skippedCount + 1,
      errorSummary: JSON.stringify(notes),
      params: JSON.stringify({
        ...claim.params,
        stuckSkips: skips,
        lease: null,
        leaseUntil: null,
      }),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(stillClaimed(job.id, claim.raw));
  return changesOf(result) === 1 ? params.slice : null;
}

/** Ends an import that cannot finish. */
export async function failMailImport(
  db: Db,
  jobId: string,
  reason: string,
): Promise<void> {
  const job = await importJobById(db, jobId);
  if (!job || (job.status !== "running" && job.status !== "uploading")) {
    return;
  }
  const notes = [
    ...notesOf(job),
    { row: job.processedRows, reason: reason.slice(0, 300) },
  ].slice(-MAX_NOTES);
  await db
    .update(asyncJobs)
    .set({
      status: "failed",
      errorSummary: JSON.stringify(notes),
      updatedAt: Math.floor(Date.now() / 1000),
    })
    .where(and(eq(asyncJobs.id, jobId), eq(asyncJobs.status, job.status)));
}

/**
 * Cancels an import (an upload is aborted), or deletes a finished one's
 * record and file. Messages already imported stay.
 */
export async function deleteMailImport(
  db: Db,
  env: CloudflareBindings,
  job: AsyncJob,
): Promise<void> {
  await db.delete(asyncJobs).where(eq(asyncJobs.id, job.id));
  const params = importParams(job);
  if (params.uploadId) {
    await env.R2.resumeMultipartUpload(job.storageKey!, params.uploadId)
      .abort()
      .catch(() => {});
  }
  await env.R2.delete(job.storageKey!).catch(() => {});
}

/** Queues the slice an import is waiting for, or runs it here in demo mode. */
export async function resumeMailImport(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  slice: number,
): Promise<void> {
  if (isDemoMode(env)) {
    await runMailImportInline(db, env, jobId, slice);
    return;
  }
  const message: MailImportMessage = { type: "mail_import", jobId, slice };
  await env.EMAIL_QUEUE.send(message);
}

/**
 * Runs an import's slices one after another, for deployments without a
 * queue consumer (DEMO_MODE). The first error fails the import.
 */
export async function runMailImportInline(
  db: Db,
  env: CloudflareBindings,
  jobId: string,
  from = 0,
): Promise<void> {
  let slice: number | null = from;
  try {
    while (slice !== null) {
      slice = await runMailImportSlice(db, env, jobId, slice);
    }
  } catch (error) {
    console.error(`[import] ${jobId} failed:`, error);
    await failMailImport(
      db,
      jobId,
      error instanceof Error ? error.message : "import failed",
    );
  }
}

/**
 * Hourly. The uploaded file goes 24 hours after the import ended; an upload
 * nobody finished in 24 hours is given up; a running import that stopped
 * moving is queued again (three times, then failed).
 */
export async function reapMailImports(
  db: Db,
  env: CloudflareBindings,
  nowSeconds: number,
): Promise<{ sourcesDeleted: number; resumed: number; failed: number }> {
  const ended = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_import"),
        inArray(asyncJobs.status, ["completed", "failed"]),
        lt(asyncJobs.updatedAt, nowSeconds - SOURCE_TTL_SECONDS),
        sql`json_extract(${asyncJobs.params}, '$.sourceDeleted') IS NOT 1`,
      ),
    )
    .limit(100);
  for (const job of ended) {
    const params = importParams(job);
    if (params.uploadId) {
      await env.R2.resumeMultipartUpload(job.storageKey!, params.uploadId)
        .abort()
        .catch(() => {});
    }
    await env.R2.delete(job.storageKey!);
    await db
      .update(asyncJobs)
      .set({
        params: JSON.stringify({ ...params, sourceDeleted: true }),
      })
      .where(eq(asyncJobs.id, job.id));
  }

  const abandoned = await db
    .select({ id: asyncJobs.id })
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_import"),
        eq(asyncJobs.status, "uploading"),
        lt(asyncJobs.updatedAt, nowSeconds - UPLOAD_TTL_SECONDS),
      ),
    )
    .limit(100);
  for (const job of abandoned) {
    await failMailImport(db, job.id, "the upload was not finished");
  }

  const idle = await db
    .select()
    .from(asyncJobs)
    .where(
      and(
        eq(asyncJobs.jobType, "mail_import"),
        eq(asyncJobs.status, "running"),
        lt(asyncJobs.updatedAt, nowSeconds - IDLE_SECONDS),
      ),
    )
    .limit(100);
  let resumed = 0;
  let failed = abandoned.length;
  for (const job of idle) {
    const recovery = await recoverIdleJob<ImportParams>(db, job, nowSeconds);
    if (recovery.action === "fail") {
      await failMailImport(db, job.id, "stalled");
      failed++;
    } else if (recovery.action === "resume") {
      await resumeMailImport(db, env, job.id, recovery.params.slice);
      resumed++;
    }
  }
  return { sourcesDeleted: ended.length, resumed, failed };
}

/** Tells the admin the import is done: open tabs and Web Push. */
async function notifyImportDone(
  env: CloudflareBindings,
  job: AsyncJob,
  inbox: string,
  imported: number,
  skipped: number,
): Promise<void> {
  if (!job.requestedBy) return;
  try {
    await env.NOTIFICATIONS_HUB.get(
      env.NOTIFICATIONS_HUB.idFromName(job.requestedBy),
    ).fetch(
      new Request("http://do/realtime", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "import_done",
          inbox,
          jobId: job.id,
          imported,
          skipped,
        }),
      }),
    );
  } catch (error) {
    console.warn("[import] done notice not sent:", error);
  }
}
