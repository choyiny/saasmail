import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { nanoid } from "nanoid";
import { attachments } from "../db/attachments.schema";
import { jmapDrafts } from "../db/jmap-drafts.schema";
import { jmapSubmissions } from "../db/jmap-submissions.schema";
import { outboxEmails } from "../db/outbox-emails.schema";
import { sentEmails } from "../db/sent-emails.schema";
import { cancelSequencesForPerson } from "../lib/cancel-sequence";
import {
  createEmailSender,
  type EmailSender,
  type SendEmailAttachment,
} from "../lib/email-sender";
import type { AllowedInboxes } from "../lib/inbox-permissions";
import type { OutboxSendResult } from "../lib/outbox";
import {
  buildSubmissionMessage,
  loadDeliveredMessageIds,
  parseContentJson,
  sendSubmission,
  submissionAttachmentFilename,
  submissionAttachmentLeaves,
  submissionFromHeader,
  submissionUnsendableLeaves,
  type SubmissionMessage,
} from "../lib/submit-message";
import { MAX_OBJECTS_IN_SET } from "./constants";
import type { ContentAddress, ContentLeaf, JmapContentRow } from "./content";
import { resolveCreationRef } from "./creation-refs";
import { loadDraftsByIds, type JmapDraftRow } from "./drafts";
import type { JmapMethodError } from "./emails";
import { listUsableIdentities, type IdentityRow } from "./mailboxes";
import type { JmapMethodContext } from "./methods";
import {
  applyOnSuccessStep,
  isMethodError,
  onSuccessForCreation,
  parseOnSuccessArgs,
  wantsImplicitEmailSet,
  type ParsedOnSuccess,
} from "./on-success";
import {
  parseAnyEmailId,
  parseSubmissionId,
  publicAccountId,
  publicDraftEmailId,
  publicIdentityId,
  publicSubmissionId,
  publicThreadId,
} from "./public-ids";
import { buildJmapSentRow } from "./sent-row";
import { currentJmapState, parseJmapState } from "./state";
import {
  checkContentRecipients,
  resolveEnvelope,
  submissionRecipients,
  type Envelope,
  type SubmissionSetError,
} from "./submission-rules";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = DrizzleD1Database<any>;

const CREATE_PROPERTIES = new Set(["identityId", "emailId", "envelope"]);

type StagedAttachment = {
  id: string;
  leaf: ContentLeaf;
  filename: string;
  r2Key: string;
};

type CreateOutcome = {
  created: Record<string, unknown> | null;
  error: SubmissionSetError | null;
  /** Internal id of an accepted submission, so the call can run its step. */
  acceptedId?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNullish(value: unknown): boolean {
  return value === undefined || value === null;
}

function nonEmptyOrNull<T extends Record<string, unknown>>(value: T): T | null {
  return Object.keys(value).length === 0 ? null : value;
}

/** RFC 8620 UTCDate: no fractional seconds. */
function utcDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function rejected(error: SubmissionSetError): CreateOutcome {
  return { created: null, error };
}

function parseSetArguments(args: Record<string, unknown>): {
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  destroy: string[];
  error: JmapMethodError | null;
} {
  const empty = { create: {}, update: {}, destroy: [] as string[] };
  if (!isNullish(args.create) && !isObject(args.create)) {
    return {
      ...empty,
      error: { type: "invalidArguments", properties: ["create"] },
    };
  }
  if (!isNullish(args.update) && !isObject(args.update)) {
    return {
      ...empty,
      error: { type: "invalidArguments", properties: ["update"] },
    };
  }
  if (
    !isNullish(args.destroy) &&
    (!Array.isArray(args.destroy) ||
      !args.destroy.every((id) => typeof id === "string"))
  ) {
    return {
      ...empty,
      error: { type: "invalidArguments", properties: ["destroy"] },
    };
  }
  return {
    create: (args.create ?? {}) as Record<string, unknown>,
    update: (args.update ?? {}) as Record<string, unknown>,
    destroy: (args.destroy ?? []) as string[],
    error: null,
  };
}

/**
 * Spec §3.4 step 1 as ONE D1 transaction: the claim, then the intention and the
 * staged attachment rows, each guarded by "the claim is ours". A lost claim
 * (another submission holds the draft) therefore writes nothing. Raw D1 is used
 * because the guarded INSERT … SELECT and per-statement `changes` are needed.
 */
async function claimAndRecordIntention(
  d1: D1Database,
  input: {
    submissionId: string;
    sentEmailId: string;
    userId: string;
    draftId: string;
    contentId: string;
    identityId: string;
    identityEmail: string;
    emailId: string;
    threadId: string;
    envelope: Envelope;
    staged: StagedAttachment[];
    /** Spec §3.4 step 1: what this create's on-success step will do. */
    onSuccessMode: string;
    onSuccessPatchJson: string | null;
    /** The exact From header of the first attempt; retries reuse it. */
    fromHeader: string;
    now: number;
  },
): Promise<boolean> {
  const ours = `EXISTS (SELECT 1 FROM jmap_drafts WHERE id = ? AND submit_attempt_id = ? AND submit_state = 'submitting')`;
  const statements: D1PreparedStatement[] = [
    d1
      .prepare(
        `UPDATE jmap_drafts SET submit_state = 'submitting', submit_attempt_id = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND submit_state IS NULL`,
      )
      .bind(input.submissionId, input.now, input.draftId, input.userId),
    d1
      .prepare(
        `INSERT INTO jmap_submissions (id, user_id, attempt_state, on_success_state, draft_id, content_id, identity_id, identity_email, email_id, thread_id, sent_email_id, envelope_json, on_success_mode, on_success_patch_json, from_header, send_at, undo_status, created_at)
         SELECT ?, ?, 'claimed', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final', ?
         WHERE ${ours}`,
      )
      .bind(
        input.submissionId,
        input.userId,
        input.draftId,
        input.contentId,
        input.identityId,
        input.identityEmail,
        input.emailId,
        input.threadId,
        input.sentEmailId,
        JSON.stringify(input.envelope),
        input.onSuccessMode,
        input.onSuccessPatchJson,
        input.fromHeader,
        input.now,
        input.now,
        input.draftId,
        input.submissionId,
      ),
    ...input.staged.map((item) =>
      d1
        .prepare(
          `INSERT INTO attachments (id, email_id, kind, filename, content_type, size, r2_key, content_id, created_at)
           SELECT ?, ?, 'sent', ?, ?, ?, ?, ?, ?
           WHERE ${ours}`,
        )
        .bind(
          item.id,
          input.sentEmailId,
          item.filename,
          item.leaf.type,
          item.leaf.size,
          item.r2Key,
          item.leaf.cid,
          input.now,
          input.draftId,
          input.submissionId,
        ),
    ),
  ];
  const results = await d1.batch(statements);
  return (results[0]?.meta?.changes ?? 0) === 1;
}

/**
 * Undo an intention that will never be accepted: R2 objects first, then the
 * rows (spec §10.3), then release the claim. When an R2 delete fails the
 * attachment rows stay, so the hourly reaper (PR 2) retries the delete.
 */
async function abandonIntention(
  db: Db,
  env: CloudflareBindings,
  input: {
    submissionId: string;
    sentEmailId: string;
    draftId: string;
    staged: StagedAttachment[];
  },
): Promise<void> {
  const removed = await Promise.allSettled(
    input.staged.map((item) => env.R2.delete(item.r2Key)),
  );
  const allRemoved = removed.every((result) => result.status === "fulfilled");
  const statements = [
    ...(allRemoved
      ? [
          db
            .delete(attachments)
            .where(
              and(
                eq(attachments.emailId, input.sentEmailId),
                eq(attachments.kind, "sent"),
              ),
            ),
        ]
      : []),
    db
      .delete(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, input.sentEmailId)),
    db
      .delete(jmapSubmissions)
      .where(eq(jmapSubmissions.id, input.submissionId)),
    db
      .update(jmapDrafts)
      .set({ submitState: null, submitAttemptId: null })
      .where(
        and(
          eq(jmapDrafts.id, input.draftId),
          eq(jmapDrafts.submitAttemptId, input.submissionId),
        ),
      ),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.batch(statements as any);
}

/** True when an outbox row for this send exists (or can't be ruled out). */
async function outboxRowSurvives(
  db: Db,
  sentEmailId: string,
): Promise<boolean> {
  try {
    const rows = await db
      .select({ id: outboxEmails.id })
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, sentEmailId))
      .limit(1);
    return rows.length > 0;
  } catch {
    return true;
  }
}

/**
 * A draft stays `queued` while the outbox retries its accepted submission.
 * Once that row is gone (sent) or `failed`, the lock is stale: release it.
 */
async function releaseFinishedQueuedLock(
  db: Db,
  draft: JmapDraftRow,
): Promise<void> {
  if (draft.submitState !== "queued" || !draft.submitAttemptId) return;
  const [holder] = await db
    .select({ sentEmailId: jmapSubmissions.sentEmailId })
    .from(jmapSubmissions)
    .where(eq(jmapSubmissions.id, draft.submitAttemptId))
    .limit(1);
  if (holder) {
    const [outbox] = await db
      .select({ status: outboxEmails.status })
      .from(outboxEmails)
      .where(eq(outboxEmails.sentEmailId, holder.sentEmailId))
      .limit(1);
    if (outbox && outbox.status !== "failed") return;
  }
  await db
    .update(jmapDrafts)
    .set({ submitState: null, submitAttemptId: null })
    .where(
      and(
        eq(jmapDrafts.id, draft.id),
        eq(jmapDrafts.submitState, "queued"),
        eq(jmapDrafts.submitAttemptId, draft.submitAttemptId),
      ),
    );
}

/**
 * Spec §3.4 step 3 for `sent` / `retrying`: the Sent row (written HIDDEN — its
 * submission's `on_success_state` stays 'pending'), acceptance, the lock, and the
 * release of the owned outbox row once nothing else owes bookkeeping. A `sent`
 * draft keeps its `submitting` lock: only the on-success step may unlock it,
 * because until then the Email is neither a draft nor a visible Sent Email.
 */
async function recordAcceptedSubmission(
  db: Db,
  input: {
    submissionId: string;
    sentEmailId: string;
    draftId: string;
    content: JmapContentRow;
    message: SubmissionMessage;
    result: OutboxSendResult;
  },
): Promise<void> {
  const { message, result } = input;
  const now = Math.floor(Date.now() / 1000);
  // The one Sent-row writer for JMAP sends; recovery writes the same row.
  const sentRow = await buildJmapSentRow(db, {
    sentEmailId: input.sentEmailId,
    content: input.content,
    message,
    status: result.outcome,
    resendId: result.send.result?.id ?? null,
    providerResult: result.send.result ?? null,
    now,
  });
  const personId = sentRow.personId!;
  const statements = [
    db.insert(sentEmails).values(sentRow),
    db
      .update(jmapSubmissions)
      .set({ attemptState: "accepted" })
      .where(eq(jmapSubmissions.id, input.submissionId)),
    db
      .update(jmapDrafts)
      .set(
        result.outcome === "sent"
          ? { submitState: "submitting" as const }
          : { submitState: "queued" as const },
      )
      .where(
        and(
          eq(jmapDrafts.id, input.draftId),
          eq(jmapDrafts.submitAttemptId, input.submissionId),
        ),
      ),
    // The provider accepted and this batch is the JMAP bookkeeping that owes the
    // outbox confirmation, so the held row can go. A `retrying` row still reads
    // `pending` and is untouched.
    db
      .delete(outboxEmails)
      .where(
        and(
          eq(outboxEmails.sentEmailId, input.sentEmailId),
          eq(outboxEmails.bookkeepingOwner, "jmap"),
          eq(outboxEmails.status, "bookkeeping_pending"),
        ),
      ),
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db.batch(statements as any);
  try {
    await cancelSequencesForPerson(db, personId);
  } catch (error) {
    console.error(
      `[jmap] cancelling sequences after submission ${input.submissionId} failed:`,
      error,
    );
  }
}

async function createSubmission(
  db: Db,
  allowed: AllowedInboxes,
  userId: string,
  input: unknown,
  ctx: JmapMethodContext,
  sender: EmailSender,
  identities: Map<string, IdentityRow>,
  onSuccess: ParsedOnSuccess,
  creationId: string,
): Promise<CreateOutcome> {
  if (!isObject(input)) return rejected({ type: "invalidProperties" });
  const unknownProperties = Object.keys(input).filter(
    (key) => !CREATE_PROPERTIES.has(key),
  );
  if (unknownProperties.length > 0) {
    return rejected({
      type: "invalidProperties",
      properties: unknownProperties,
    });
  }

  // Step 1: a draft this user owns, and an identity usable right now. Both are
  // resolved before any envelope or size check, so a foreign draft id can't be
  // probed for either.
  const invalid: string[] = [];
  const emailId =
    typeof input.emailId === "string"
      ? resolveCreationRef(input.emailId, ctx.createdIds)
      : null;
  const ref = emailId ? parseAnyEmailId(emailId) : null;
  const found =
    ref && ref.kind === "draft"
      ? (await loadDraftsByIds(db, allowed, userId, [ref.id])).get(ref.id)
      : undefined;
  if (!found) invalid.push("emailId");
  const identity =
    typeof input.identityId === "string"
      ? identities.get(input.identityId)
      : undefined;
  if (!identity) invalid.push("identityId");
  if (!found || !identity) {
    return rejected({
      type: "invalidProperties",
      properties: invalid,
      description:
        "emailId must be one of your drafts and identityId one of your identities",
    });
  }
  const { draft, content } = found;
  const identityEmail = identity.email.trim().toLowerCase();

  // Step 2: the From header is the identity.
  const from = parseContentJson<ContentAddress[]>(content.fromJson, [])[0];
  if (!from || from.email.trim().toLowerCase() !== identityEmail) {
    return rejected({
      type: "forbiddenFrom",
      description: "The Email's From address is not this identity's address",
    });
  }

  // Steps 3–4: exactly one To, Cc, no Bcc, sendable, at most 51.
  const recipientError = checkContentRecipients(content);
  if (recipientError) return rejected(recipientError);

  // Step 5: the envelope.
  const envelope = resolveEnvelope(
    input.envelope,
    identityEmail,
    submissionRecipients(content),
  );
  if (envelope.error) return rejected(envelope.error);

  // Step 6: everything in the Email can be sent, its attachments still
  // resolve, and the message fits the provider.
  const replyTo = parseContentJson<ContentAddress[] | null>(
    content.replyToJson,
    null,
  );
  if (replyTo && replyTo.length > 1) {
    return rejected({
      type: "invalidEmail",
      properties: ["replyTo"],
      description: "Only one Reply-To address can be sent",
    });
  }
  if (submissionUnsendableLeaves(content).length > 0) {
    return rejected({
      type: "invalidEmail",
      properties: ["bodyStructure"],
      description:
        "A text part that is neither the text nor the HTML body must be an uploaded blob",
    });
  }
  const leaves = submissionAttachmentLeaves(content);
  const heads = await Promise.all(
    leaves.map((leaf) => ctx.env.R2.head(leaf.r2Key!)),
  );
  if (heads.some((head) => head === null)) {
    return rejected({
      type: "invalidEmail",
      properties: ["attachments"],
      description: "An attachment of this Email is no longer available",
    });
  }
  const maxSize = sender.maxMessageBytes();
  if (content.size > maxSize) {
    return rejected({
      type: "tooLarge",
      maxSize,
      description: `The message is ${content.size} octets; the provider accepts ${maxSize}`,
    });
  }

  // Step 7: claim + intention + staged rows, atomically.
  await releaseFinishedQueuedLock(db, draft);
  const now = Math.floor(Date.now() / 1000);
  const submissionId = nanoid();
  const sentEmailId = nanoid();
  const staged: StagedAttachment[] = leaves.map((leaf) => {
    const id = nanoid();
    const filename = submissionAttachmentFilename(leaf);
    return {
      id,
      leaf,
      filename,
      r2Key: `attachments/sent/${sentEmailId}/${id}/${filename}`,
    };
  });
  const threadId = publicThreadId(content.threadKey);
  // Spec §3.4 step 1: the intention records what its on-success step will do and
  // the exact From the first attempt uses, so a retry can replay it verbatim.
  const forCreate = onSuccessForCreation(onSuccess, creationId);
  const claimed = await claimAndRecordIntention(ctx.env.DB, {
    submissionId,
    sentEmailId,
    userId,
    draftId: draft.id,
    contentId: content.id,
    identityId: publicIdentityId(identityEmail),
    identityEmail,
    emailId: publicDraftEmailId(draft.id),
    threadId,
    envelope: envelope.envelope!,
    staged,
    onSuccessMode: forCreate.mode,
    onSuccessPatchJson: forCreate.patch
      ? JSON.stringify(forCreate.patch)
      : null,
    fromHeader: submissionFromHeader(content, {
      email: identityEmail,
      displayName: identity.displayName ?? null,
    }),
    now,
  });
  if (!claimed) {
    return rejected({
      type: "forbiddenToSend",
      description: "This message is already being sent",
    });
  }

  // D1 rows exist; now the R2 copies (spec §3.5 order).
  const copies = await Promise.allSettled(
    staged.map(async (item) => {
      const object = await ctx.env.R2.get(item.leaf.r2Key!);
      if (!object) {
        throw new Error(`content object ${item.leaf.r2Key} is missing`);
      }
      const bytes = new Uint8Array(await object.arrayBuffer());
      await ctx.env.R2.put(item.r2Key, bytes, {
        httpMetadata: { contentType: item.leaf.type },
      });
      return bytes;
    }),
  );
  const failedCopy = copies.find(
    (copy): copy is PromiseRejectedResult => copy.status === "rejected",
  );
  if (failedCopy) {
    await abandonIntention(db, ctx.env, {
      submissionId,
      sentEmailId,
      draftId: draft.id,
      staged,
    });
    throw failedCopy.reason;
  }
  const sendAttachments: SendEmailAttachment[] = staged.map((item, index) => ({
    filename: item.filename,
    contentType: item.leaf.type,
    content: (copies[index] as PromiseFulfilledResult<Uint8Array>).value,
    contentId: item.leaf.cid,
    disposition: item.leaf.disposition === "inline" ? "inline" : "attachment",
  }));

  const message = buildSubmissionMessage(
    content,
    { email: identityEmail, displayName: identity.displayName ?? null },
    sendAttachments,
    await loadDeliveredMessageIds(db, content),
  );
  let result: OutboxSendResult;
  try {
    result = await sendSubmission({
      db,
      env: ctx.env,
      sender,
      sentEmailId,
      message,
      // Spec §3.4: the provider-accepted row is held until the JMAP bookkeeping
      // (the Sent row and the on-success step) is durable, so a crash in
      // between leaves evidence of an accepted send instead of resending it.
      bookkeepingOwner: "jmap",
    });
  } catch (err) {
    // sendViaOutbox deletes its own row only when the provider call throws. A
    // row that survived (D1 failed after the provider call) will be retried,
    // and its retry reads the staged attachment rows: keep everything, and
    // leave the claimed intention for PR 6's recovery.
    if (!(await outboxRowSurvives(db, sentEmailId))) {
      try {
        await abandonIntention(db, ctx.env, {
          submissionId,
          sentEmailId,
          draftId: draft.id,
          staged,
        });
      } catch (cleanupError) {
        console.error(
          `[jmap] cleanup after a failed submission ${submissionId} failed:`,
          cleanupError,
        );
      }
    }
    throw err;
  }

  if (result.outcome === "sent" || result.outcome === "retrying") {
    // The provider has the message: from here on the create is reported as
    // created whatever happens, or the client would send it again. If the
    // bookkeeping fails, the claimed intention and the held outbox row stay
    // (the draft stays locked) and the hourly recovery records the send.
    let recorded = true;
    try {
      await recordAcceptedSubmission(db, {
        submissionId,
        sentEmailId,
        draftId: draft.id,
        content,
        message,
        result,
      });
    } catch (error) {
      recorded = false;
      console.error(
        `[jmap] recording accepted submission ${submissionId} failed; recovery will record it:`,
        error,
      );
    }
    return {
      created: {
        id: publicSubmissionId(submissionId),
        threadId,
        sendAt: utcDate(now),
        undoStatus: "final",
      },
      error: null,
      acceptedId: recorded ? submissionId : undefined,
    };
  }

  // Terminal failure (or, defensively, suppression): the JMAP path writes no
  // Sent row (spec §3.2) and leaves nothing staged.
  await abandonIntention(db, ctx.env, {
    submissionId,
    sentEmailId,
    draftId: draft.id,
    staged,
  });
  return rejected({
    type: "forbiddenToSend",
    description:
      result.send.result?.error?.message ?? "The message could not be sent",
  });
}

async function knownSubmissionIds(
  db: Db,
  userId: string,
  publicIds: string[],
): Promise<Set<string>> {
  const internal = [
    ...new Set(
      publicIds
        .map((id) => parseSubmissionId(id))
        .filter((id): id is string => id !== null),
    ),
  ];
  const known = new Set<string>();
  // Chunked: D1 binds at most 100 parameters per statement.
  for (let start = 0; start < internal.length; start += 90) {
    const rows = await db
      .select({ id: jmapSubmissions.id })
      .from(jmapSubmissions)
      .where(
        and(
          eq(jmapSubmissions.userId, userId),
          eq(jmapSubmissions.attemptState, "accepted"),
          inArray(jmapSubmissions.id, internal.slice(start, start + 90)),
        ),
      );
    for (const row of rows) known.add(publicSubmissionId(row.id));
  }
  return known;
}

export async function emailSubmissionSet(
  db: Db,
  allowed: AllowedInboxes,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  user: any,
  args: Record<string, unknown>,
  ctx: JmapMethodContext,
): Promise<
  | {
      response: Record<string, unknown>;
      followUps: { name: string; result: Record<string, unknown> }[];
    }
  | JmapMethodError
> {
  const userId: string = user.id;
  // RFC 8621 §7.5. Malformed arguments fail the whole call; a well-formed one
  // is stored on each accepted create's intention (see claimAndRecordIntention).
  const onSuccess = parseOnSuccessArgs(args);
  if (isMethodError(onSuccess)) return onSuccess;

  const parsed = parseSetArguments(args);
  if (parsed.error) return parsed.error;
  const { create, update, destroy } = parsed;
  if (
    Object.keys(create).length + Object.keys(update).length + destroy.length >
    MAX_OBJECTS_IN_SET
  ) {
    return {
      type: "requestTooLarge",
      description: `create + update + destroy exceeds maxObjectsInSet (${MAX_OBJECTS_IN_SET})`,
    };
  }

  const current = await currentJmapState(db, allowed, userId);
  if (!isNullish(args.ifInState)) {
    const ifInState = parseJmapState(args.ifInState);
    if (
      !ifInState ||
      ifInState.seq !== current.parts.seq ||
      ifInState.fp !== current.parts.fp
    ) {
      return { type: "stateMismatch" };
    }
  }

  const sender = ctx.sender ?? createEmailSender(ctx.env);
  const identities = new Map(
    (await listUsableIdentities(db, allowed)).map((row) => [
      publicIdentityId(row.email),
      row,
    ]),
  );

  // Read before any create sends: nothing that can fail runs between the
  // first provider call and the response.
  const known = await knownSubmissionIds(db, userId, [
    ...Object.keys(update),
    ...destroy,
  ]);

  const created: Record<string, Record<string, unknown>> = {};
  const notCreated: Record<string, SubmissionSetError> = {};
  /** Internal ids of submissions accepted in this call; Task 5 runs their steps. */
  const acceptedIds: string[] = [];
  for (const [creationId, input] of Object.entries(create)) {
    // One create failing must not hide the others: a create already sent in
    // this call is reported, so the client doesn't resend it. A failed create
    // leaves its draft locked whenever a send may have happened (the claim is
    // only released when nothing was sent).
    let outcome: CreateOutcome;
    try {
      outcome = await createSubmission(
        db,
        allowed,
        userId,
        input,
        ctx,
        sender,
        identities,
        onSuccess,
        creationId,
      );
    } catch (error) {
      console.error(
        `[jmap] EmailSubmission/set create ${creationId} failed:`,
        error,
      );
      notCreated[creationId] = {
        type: "serverFail",
        description: "The submission could not be completed",
      };
      continue;
    }
    if (outcome.error) notCreated[creationId] = outcome.error;
    else {
      created[creationId] = outcome.created!;
      if (outcome.acceptedId) acceptedIds.push(outcome.acceptedId);
    }
  }

  const readOnly = (id: string): SubmissionSetError =>
    known.has(id)
      ? {
          type: "forbidden",
          description: "Submissions can't be changed or deleted",
        }
      : { type: "notFound" };
  const notUpdated: Record<string, SubmissionSetError> = {};
  for (const id of Object.keys(update)) notUpdated[id] = readOnly(id);
  const notDestroyed: Record<string, SubmissionSetError> = {};
  for (const id of destroy) notDestroyed[id] = readOnly(id);

  const response: Record<string, unknown> = {
    accountId: publicAccountId(userId),
    oldState: current.state,
    newState: current.state,
    created: nonEmptyOrNull(created),
    updated: null,
    destroyed: null,
    notCreated: nonEmptyOrNull(notCreated),
    notUpdated: nonEmptyOrNull(notUpdated),
    notDestroyed: nonEmptyOrNull(notDestroyed),
  };

  // Spec §3.4 step 4: once per call, after every create has run, the on-success
  // step files each accepted draft into Sent (the alias), flags or destroys it,
  // and otherwise reveals the Sent row. Each submission's step is idempotent
  // through its own `applied` marker.
  const followUps: { name: string; result: Record<string, unknown> }[] = [];
  if (acceptedIds.length > 0) {
    try {
      const implicit = await applyOnSuccessStep({
        db,
        allowed,
        user,
        ctx,
        submissionIds: acceptedIds,
        emitResponse: wantsImplicitEmailSet(onSuccess),
      });
      if (implicit) followUps.push(implicit);
    } catch (error) {
      // The messages were sent: answer with the submissions regardless. Their
      // steps stay pending (drafts locked), and the hourly recovery runs them.
      console.error(
        "[jmap] on-success step failed; recovery will apply it:",
        error,
      );
      if (wantsImplicitEmailSet(onSuccess)) {
        followUps.push({
          name: "error",
          result: {
            type: "serverFail",
            description: "The on-success step will be completed later",
          },
        });
      }
    }
  }
  // The step wrote change rows, so the new state is read after it. A failed
  // read keeps the old state rather than failing a call that already sent:
  // the client then just sees these changes again through /changes.
  try {
    response.newState = (await currentJmapState(db, allowed, userId)).state;
  } catch (error) {
    console.error("[jmap] reading the state after a submission failed:", error);
  }
  return { response, followUps };
}
