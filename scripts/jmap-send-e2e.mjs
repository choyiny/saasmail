//
// End-to-end check of JMAP sending against a running saasmail deployment
// (docs/superpowers/specs/2026-09-25-jmap-email-submission-design.md §7).
// It SENDS REAL EMAIL to JMAP_TO (and JMAP_CC when set), including one delayed
// send (HOLDFOR=20) that the queue releases while the script waits.
//
//   JMAP_BASE_URL=https://mail.example.com \
//   JMAP_API_KEY=sk_... \
//   JMAP_FROM=hello@example.com \
//   JMAP_TO=privacy@example.com \
//   yarn jmap:e2e
//
// Optional:
//   JMAP_CC                  one Cc recipient
//   JMAP_OLD_ACCOUNT_ID      an account id from before a reset (the user id, or a previous
//                            version's hashed id); checks it is rejected
//   JMAP_EXPECT_DELIVERY=1   poll JMAP_TO's saasmail inbox (the key's user must be able to read it),
//                            and send one more message: a follow-up to the first, whose delivered
//                            In-Reply-To must be the Message-ID the first was delivered with
//   JMAP_DELIVERY_TIMEOUT_S  delivery polling budget in seconds (default 120)
//
// Exit codes: 0 every check passed, 1 a check failed, 2 bad configuration.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
export const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";
export const SUBMISSION_CAPABILITY = "urn:ietf:params:jmap:submission";
export const USING = [CORE_CAPABILITY, MAIL_CAPABILITY, SUBMISSION_CAPABILITY];
export const JMAP_ID_PATTERN = /^[A-Za-z0-9_-]{1,255}$/;

/** 1×1 transparent PNG, sent as the inline (cid) image. */
export const PNG_BYTES = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  ),
  (char) => char.charCodeAt(0),
);
export const INLINE_CID = "logo@jmap-e2e";

export const EMAIL_GET_PROPERTIES = [
  "id",
  "blobId",
  "threadId",
  "mailboxIds",
  "keywords",
  "size",
  "receivedAt",
  "messageId",
  "inReplyTo",
  "references",
  "sender",
  "from",
  "to",
  "cc",
  "bcc",
  "replyTo",
  "subject",
  "sentAt",
  "hasAttachment",
  "preview",
  "bodyStructure",
  "textBody",
  "htmlBody",
  "attachments",
  "bodyValues",
];

/** Everything except the id and the two mutable properties (RFC 8621 §4.1). */
export const IMMUTABLE_EMAIL_PROPERTIES = EMAIL_GET_PROPERTIES.filter(
  (property) => !["id", "mailboxIds", "keywords"].includes(property),
);

export const MAX_DELAYED_SEND = 86400;

/**
 * RFC 8621 §7 + RFC 4865 §3: maxDelayedSend and FUTURERELEASE's two EHLO
 * arguments, the longest hold in seconds and the latest release date-time in
 * UTC (about now + maxDelayedSend).
 */
export function delayedSendCapabilityOk(capability, nowMs) {
  if (!isPlainObject(capability)) return false;
  const extensions = capability.submissionExtensions;
  if (
    capability.maxDelayedSend !== MAX_DELAYED_SEND ||
    !isPlainObject(extensions) ||
    stableStringify(Object.keys(extensions)) !==
      stableStringify(["FUTURERELEASE"])
  ) {
    return false;
  }
  const args = extensions.FUTURERELEASE;
  if (!Array.isArray(args) || args.length !== 2) return false;
  const [interval, latest] = args;
  return (
    interval === String(MAX_DELAYED_SEND) &&
    typeof latest === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(latest) &&
    Math.abs(Date.parse(latest) - (nowMs + MAX_DELAYED_SEND * 1000)) <
      5 * 60_000
  );
}

export class CheckFailed extends Error {}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readConfig(env) {
  const required = ["JMAP_BASE_URL", "JMAP_API_KEY", "JMAP_FROM", "JMAP_TO"];
  const missing = required.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    return {
      error: `Missing required environment variables: ${missing.join(", ")}`,
    };
  }
  let baseUrl;
  try {
    baseUrl = new URL(env.JMAP_BASE_URL.trim()).origin;
  } catch {
    return { error: `JMAP_BASE_URL is not a URL: ${env.JMAP_BASE_URL}` };
  }
  const apiKey = env.JMAP_API_KEY.trim();
  if (!apiKey.startsWith("sk_")) {
    return { error: "JMAP_API_KEY must be a saasmail API key (sk_...)" };
  }
  const timeout = Number(env.JMAP_DELIVERY_TIMEOUT_S ?? "120");
  if (!Number.isInteger(timeout) || timeout <= 0) {
    return { error: "JMAP_DELIVERY_TIMEOUT_S must be a positive integer" };
  }
  return {
    config: {
      baseUrl,
      apiKey,
      from: env.JMAP_FROM.trim().toLowerCase(),
      to: env.JMAP_TO.trim().toLowerCase(),
      cc: env.JMAP_CC?.trim().toLowerCase() || null,
      oldAccountId: env.JMAP_OLD_ACCOUNT_ID?.trim() || null,
      expectDelivery: env.JMAP_EXPECT_DELIVERY === "1",
      deliveryTimeoutSeconds: timeout,
    },
  };
}

/** RFC 6570 level-1 expansion, which is all the JMAP Session templates use. */
export function expandUriTemplate(template, values) {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, name) => {
    if (!(name in values)) {
      throw new Error(`No value for {${name}} in URI template ${template}`);
    }
    return encodeURIComponent(String(values[name]));
  });
}

export function resolveUrl(baseUrl, pathOrUrl) {
  return new URL(pathOrUrl, baseUrl).toString();
}

const ID_VALUE_KEYS = new Set([
  "id",
  "accountId",
  "threadId",
  "blobId",
  "parentId",
  "emailId",
  "identityId",
]);
const ID_LIST_KEYS = new Set([
  "ids",
  "notFound",
  "emailIds",
  "threadIds",
  "identityIds",
  "dsnBlobIds",
  "mdnBlobIds",
]);
const ID_MAP_KEYS = new Set(["mailboxIds", "accounts"]);
const SET_RESULT_KEYS = new Set(["created", "updated", "destroyed"]);

/** Every id-bearing value in a JMAP response or Session object. */
export function collectJmapIds(value, into = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectJmapIds(item, into);
    return into;
  }
  if (!isPlainObject(value)) return into;
  for (const [key, child] of Object.entries(value)) {
    if (ID_VALUE_KEYS.has(key) && typeof child === "string") {
      into.push(child);
    } else if (ID_LIST_KEYS.has(key) && Array.isArray(child)) {
      for (const item of child) {
        if (typeof item === "string") into.push(item);
      }
    } else if (ID_MAP_KEYS.has(key) && isPlainObject(child)) {
      into.push(...Object.keys(child));
    } else if (key === "primaryAccounts" && isPlainObject(child)) {
      for (const id of Object.values(child)) {
        if (typeof id === "string") into.push(id);
      }
    } else if (SET_RESULT_KEYS.has(key)) {
      // /changes returns arrays of ids. In /set, "updated" is keyed by id and
      // "created" is keyed by the client's creation id; its values carry "id",
      // which the recursion below collects.
      if (Array.isArray(child)) {
        for (const item of child) {
          if (typeof item === "string") into.push(item);
        }
      } else if (key === "updated" && isPlainObject(child)) {
        into.push(...Object.keys(child));
      }
    }
    collectJmapIds(child, into);
  }
  return into;
}

export function invalidJmapIds(value) {
  return [...new Set(collectJmapIds(value))].filter(
    (id) => !JMAP_ID_PATTERN.test(id),
  );
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

export function bytesEqual(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Is a downloaded text body part the body value it came from? RFC 8621 body
 * values are LF text; the stored part is the CRLF form of the same text, which
 * is what a `P…` download returns.
 */
export function bodyValueMatches(downloaded, value) {
  if (typeof value !== "string") return false;
  return (
    new TextDecoder().decode(downloaded) === value.replace(/\r?\n/g, "\r\n")
  );
}

function mapStrings(value, transform) {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) {
    return value.map((item) => mapStrings(item, transform));
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        mapStrings(child, transform),
      ]),
    );
  }
  return value;
}

/**
 * Body-part blob ids embed the Email id (`P<emailId>_<partId>`), so a draft and
 * its Sent copy name the same part differently. Rewrite an Email's references
 * to itself to a neutral form before comparing two Emails.
 */
export function normalizeSelfReferences(email) {
  const prefix = `P${email.id}_`;
  return mapStrings(email, (text) =>
    text.startsWith(prefix) ? `P<self>_${text.slice(prefix.length)}` : text,
  );
}

export function immutableDifferences(before, after, { ignore = [] } = {}) {
  const left = normalizeSelfReferences(before);
  const right = normalizeSelfReferences(after);
  return IMMUTABLE_EMAIL_PROPERTIES.filter(
    (property) => !ignore.includes(property),
  ).filter(
    (property) =>
      stableStringify(left[property]) !== stableStringify(right[property]),
  );
}

/** System mailbox names are "<Role> — <inbox address>" (docs/jmap.md). */
export function findMailbox(mailboxes, role, inbox) {
  const address = inbox.toLowerCase();
  return (
    mailboxes.find(
      (mailbox) =>
        mailbox.role === role &&
        typeof mailbox.name === "string" &&
        mailbox.name.toLowerCase().endsWith(address),
    ) ?? null
  );
}

const USAGE = [
  "Usage: JMAP_BASE_URL=https://mail.example.com JMAP_API_KEY=sk_... \\",
  "       JMAP_FROM=hello@example.com JMAP_TO=privacy@example.com yarn jmap:e2e",
  "Optional: JMAP_CC, JMAP_OLD_ACCOUNT_ID, JMAP_EXPECT_DELIVERY=1, JMAP_DELIVERY_TIMEOUT_S",
].join("\n");

/** A well-formed account id that is not this deployment's. */
const WRONG_ACCOUNT_ID = `a${"A".repeat(43)}`;

/**
 * Whether a delivered follow-up cites the Message-ID its original was delivered
 * with, in In-Reply-To and as the last References entry. A provider like
 * Cloudflare replaces the Message-ID, so the Sent Email's own `messageId` can
 * differ from the delivered one; the follow-up must still thread for the
 * recipient.
 */
export function citesDeliveredOriginal(followUp, original) {
  const id = original?.messageId?.[0];
  if (!id) return false;
  return (
    stableStringify(followUp?.inReplyTo) === stableStringify([id]) &&
    followUp?.references?.at(-1) === id
  );
}

function defaultSleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function createReporter(log) {
  const reporter = {
    passed: 0,
    pass(step, detail = "") {
      reporter.passed += 1;
      log(`PASS  ${step}${detail ? `: ${detail}` : ""}`);
    },
    skip(step, reason) {
      log(`SKIP  ${step}: ${reason}`);
    },
    warn(step, detail) {
      log(`WARN  ${step}: ${detail}`);
    },
    fail(step, detail) {
      log(`FAIL  ${step}: ${detail}`);
      throw new CheckFailed(`${step}: ${detail}`);
    },
    check(step, condition, passDetail, failDetail) {
      if (condition) reporter.pass(step, passDetail);
      else reporter.fail(step, failDetail);
    },
  };
  return reporter;
}

function createClient(config, fetchImpl) {
  const authorization = `Bearer ${config.apiKey}`;
  let session = null;

  async function getSession() {
    const url = resolveUrl(config.baseUrl, "/.well-known/jmap");
    const response = await fetchImpl(url, {
      headers: { Authorization: authorization },
    });
    const text = await response.text();
    if (response.status !== 200) {
      throw new CheckFailed(
        `GET ${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    session = JSON.parse(text);
    return session;
  }

  /** POST method calls; fails the run on a non-200 or on any invalid id. */
  async function call(methodCalls) {
    const url = resolveUrl(config.baseUrl, session.apiUrl);
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ using: USING, methodCalls }),
    });
    const text = await response.text();
    if (response.status !== 200) {
      throw new CheckFailed(
        `POST ${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
    }
    const body = JSON.parse(text);
    const invalid = invalidJmapIds(body);
    if (invalid.length > 0) {
      throw new CheckFailed(
        `a response carries ids that are not RFC 8620 Ids: ${JSON.stringify(
          invalid.slice(0, 5),
        )}`,
      );
    }
    return body.methodResponses;
  }

  async function upload(accountId, bytes, type) {
    const url = resolveUrl(
      config.baseUrl,
      expandUriTemplate(session.uploadUrl, { accountId }),
    );
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { Authorization: authorization, "Content-Type": type },
      body: bytes,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: response.status, json, text };
  }

  async function download(accountId, blobId, name, type) {
    const url = resolveUrl(
      config.baseUrl,
      expandUriTemplate(session.downloadUrl, { accountId, blobId, name, type }),
    );
    const response = await fetchImpl(url, {
      headers: { Authorization: authorization },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes, headers: response.headers };
  }

  return { getSession, call, upload, download };
}

/** The named response for a call id, or a failed check naming the error. */
export function methodResponse(responses, name, callId) {
  const hit = responses.find(
    ([responseName, , id]) => id === callId && responseName === name,
  );
  if (hit) return hit[1];
  const error = responses.find(
    ([responseName, , id]) => id === callId && responseName === "error",
  );
  throw new CheckFailed(
    error
      ? `${name} (call ${callId}) failed: ${JSON.stringify(error[1])}`
      : `no ${name} response for call ${callId}; got ${JSON.stringify(
          responses.map(([responseName, , id]) => [responseName, id]),
        )}`,
  );
}

function recipient(email, name = "JMAP E2E Recipient") {
  return { name, email };
}

function draftEmail(ctx, env, blobs, { subject, to, cc, bcc }) {
  return {
    mailboxIds: { [env.draftsMailboxId]: true },
    keywords: { $draft: true, $seen: true },
    from: [
      {
        name:
          env.identity.name !== env.identity.email ? env.identity.name : null,
        email: env.identity.email,
      },
    ],
    to: to ?? [recipient(ctx.config.to)],
    cc: cc ?? (ctx.config.cc ? [recipient(ctx.config.cc, "JMAP E2E Cc")] : []),
    ...(bcc ? { bcc } : {}),
    subject,
    references: [`${ctx.marker}.ref@jmap-e2e.invalid`],
    textBody: [{ partId: "text", type: "text/plain" }],
    htmlBody: [{ partId: "html", type: "text/html" }],
    bodyValues: {
      text: { value: `Plain body for ${subject}.\n` },
      html: {
        value: `<p>HTML body for ${escapeHtml(subject)}.</p><p><img src="cid:${INLINE_CID}" alt="logo"></p>`,
      },
    },
    attachments: [
      {
        blobId: blobs.png.blobId,
        type: "image/png",
        name: "logo.png",
        disposition: "inline",
        cid: INLINE_CID,
      },
      {
        blobId: blobs.notes.blobId,
        type: "text/plain",
        name: "notes.txt",
        disposition: "attachment",
      },
    ],
  };
}

function emailGet(env, callId, ids = ["#draft"]) {
  return [
    "Email/get",
    {
      accountId: env.accountId,
      ids,
      properties: EMAIL_GET_PROPERTIES,
      fetchTextBodyValues: true,
      fetchHTMLBodyValues: true,
    },
    callId,
  ];
}

async function sentEmailsWithSubject(ctx, env, subject) {
  const responses = await ctx.client.call([
    [
      "Email/query",
      {
        accountId: env.accountId,
        filter: { inMailbox: env.sentMailboxId, after: ctx.windowStart },
        limit: 100,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId: env.accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: EMAIL_GET_PROPERTIES,
        fetchTextBodyValues: true,
        fetchHTMLBodyValues: true,
      },
      "g",
    ],
  ]);
  return methodResponse(responses, "Email/get", "g").list.filter(
    (email) => email.subject === subject,
  );
}

/** Poll `address`'s inbox (JMAP_TO by default) for `subject`, or fail. */
async function awaitDelivery(ctx, env, step, subject, address = ctx.config.to) {
  const { client, report, config } = ctx;
  const inbox = findMailbox(env.mailboxes, "inbox", address);
  if (!inbox) {
    report.fail(
      `${step}: delivery`,
      `no Inbox mailbox of ${address} is visible to this API key`,
    );
  }
  const deadline = Date.now() + config.deliveryTimeoutSeconds * 1000;
  let delivered = null;
  while (!delivered && Date.now() < deadline) {
    const polled = await client.call([
      [
        "Email/query",
        {
          accountId: env.accountId,
          filter: { inMailbox: inbox.id, after: ctx.windowStart },
          limit: 50,
        },
        "q",
      ],
      [
        "Email/get",
        {
          accountId: env.accountId,
          "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
          properties: [
            "id",
            "subject",
            "from",
            "messageId",
            "inReplyTo",
            "references",
            "to",
            "attachments",
          ],
        },
        "g",
      ],
    ]);
    delivered =
      methodResponse(polled, "Email/get", "g").list.find(
        (email) => email.subject === subject,
      ) ?? null;
    if (!delivered) await ctx.sleep(5000);
  }
  if (!delivered) {
    report.fail(
      `${step}: delivery`,
      `nothing with subject "${subject}" reached ${address} within ${config.deliveryTimeoutSeconds}s`,
    );
  }
  report.pass(`${step}: delivered to ${address}`, delivered.id);
  return delivered;
}

async function stepSession(ctx) {
  const { client, report, config } = ctx;
  const step = "1 session";
  const session = await client.getSession();

  const badSessionIds = invalidJmapIds(session);
  report.check(
    `${step}: every id is an RFC 8620 Id`,
    badSessionIds.length === 0,
    `${collectJmapIds(session).length} ids`,
    `invalid: ${JSON.stringify(badSessionIds)}`,
  );

  const accountId = session.primaryAccounts?.[MAIL_CAPABILITY];
  report.check(
    `${step}: account id is the hashed form`,
    typeof accountId === "string" && /^a[A-Za-z0-9_-]{43}$/.test(accountId),
    accountId,
    `primary mail account is ${JSON.stringify(accountId)}`,
  );
  ctx.accountId = accountId;

  const accountSubmission =
    session.accounts?.[accountId]?.accountCapabilities?.[SUBMISSION_CAPABILITY];
  report.check(
    `${step}: submission capability`,
    isPlainObject(session.capabilities?.[SUBMISSION_CAPABILITY]) &&
      session.primaryAccounts?.[SUBMISSION_CAPABILITY] === accountId &&
      delayedSendCapabilityOk(accountSubmission, Date.now()),
    "maxDelayedSend 86400, FUTURERELEASE with both arguments",
    `capabilities ${JSON.stringify(
      Object.keys(session.capabilities ?? {}),
    )}, account capability ${JSON.stringify(accountSubmission)}`,
  );

  const core = session.capabilities?.[CORE_CAPABILITY] ?? {};
  report.check(
    `${step}: upload is advertised`,
    typeof session.uploadUrl === "string" &&
      session.uploadUrl.includes("{accountId}") &&
      Number(core.maxSizeUpload) > 0,
    `maxSizeUpload ${core.maxSizeUpload}`,
    `uploadUrl ${JSON.stringify(session.uploadUrl)}, maxSizeUpload ${core.maxSizeUpload}`,
  );

  // client.call() itself fails the run if any id in these responses is invalid.
  const responses = await client.call([
    ["Mailbox/get", { accountId }, "mb"],
    ["Identity/get", { accountId }, "id"],
    ["Email/query", { accountId, limit: 25 }, "q"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "threadId", "blobId", "mailboxIds"],
      },
      "g",
    ],
    [
      "Thread/get",
      {
        accountId,
        "#ids": { resultOf: "g", name: "Email/get", path: "/list/*/threadId" },
      },
      "t",
    ],
  ]);
  const mailboxes = methodResponse(responses, "Mailbox/get", "mb");
  const identities = methodResponse(responses, "Identity/get", "id");
  const threads = methodResponse(responses, "Thread/get", "t");
  report.check(
    `${step}: read surface ids are valid and states are j4`,
    [mailboxes.state, threads.state].every(
      (state) => typeof state === "string" && state.startsWith("j4-"),
    ),
    `${mailboxes.list.length} mailboxes, ${identities.list.length} identities`,
    `states ${mailboxes.state}, ${threads.state}`,
  );

  const identity = identities.list.find(
    (candidate) => candidate.email.toLowerCase() === config.from,
  );
  if (!identity) {
    report.fail(
      `${step}: JMAP_FROM identity`,
      `${config.from} is not an identity this API key can send from (available: ${
        identities.list.map((candidate) => candidate.email).join(", ") || "none"
      })`,
    );
  }
  report.pass(
    `${step}: JMAP_FROM identity`,
    `${identity.id} (${identity.name})`,
  );

  const drafts = findMailbox(mailboxes.list, "drafts", config.from);
  const sent = findMailbox(mailboxes.list, "sent", config.from);
  if (!drafts || !sent) {
    report.fail(
      `${step}: Drafts and Sent of ${config.from}`,
      `not found in ${JSON.stringify(mailboxes.list.map((mailbox) => mailbox.name))}`,
    );
  }
  report.pass(
    `${step}: Drafts and Sent of ${config.from}`,
    `${drafts.id}, ${sent.id}`,
  );

  const rejected = [["a wrong v2-shaped account", WRONG_ACCOUNT_ID]];
  if (config.oldAccountId) {
    rejected.push(["the pre-reset account", config.oldAccountId]);
  }
  for (const [label, candidate] of rejected) {
    const result = await client.call([
      ["Mailbox/get", { accountId: candidate }, "old"],
    ]);
    report.check(
      `${step}: ${label} gets accountNotFound`,
      result[0][0] === "error" && result[0][1].type === "accountNotFound",
      "",
      `got ${JSON.stringify(result[0])}`,
    );
  }
  if (!config.oldAccountId) {
    report.skip(
      `${step}: the pre-reset account`,
      "set JMAP_OLD_ACCOUNT_ID=<user id> to check it",
    );
  }

  return {
    session,
    accountId,
    identity,
    draftsMailboxId: drafts.id,
    sentMailboxId: sent.id,
    mailboxes: mailboxes.list,
  };
}

async function stepUpload(ctx, env) {
  const { client, report, config } = ctx;
  const step = "2 upload";
  const notesBytes = new TextEncoder().encode(
    `Attachment for ${ctx.marker}.\n`,
  );
  const uploads = {};
  for (const [key, bytes, type] of [
    ["png", PNG_BYTES, "image/png"],
    ["notes", notesBytes, "text/plain"],
    ["empty", new Uint8Array(0), "application/octet-stream"],
  ]) {
    const result = await client.upload(env.accountId, bytes, type);
    const json = result.json ?? {};
    report.check(
      `${step}: ${key} (${bytes.byteLength} bytes)`,
      result.status === 201 &&
        json.accountId === env.accountId &&
        typeof json.blobId === "string" &&
        json.blobId.startsWith("U") &&
        JMAP_ID_PATTERN.test(json.blobId) &&
        json.size === bytes.byteLength &&
        typeof json.type === "string" &&
        json.type.startsWith(type),
      json.blobId,
      `HTTP ${result.status}: ${result.text.slice(0, 300)}`,
    );
    uploads[key] = { blobId: json.blobId, bytes, type };
  }

  const back = await client.download(
    env.accountId,
    uploads.png.blobId,
    "logo.png",
    "image/png",
  );
  report.check(
    `${step}: the owner downloads the upload byte-identical`,
    back.status === 200 && bytesEqual(back.bytes, PNG_BYTES),
    `${back.bytes.byteLength} bytes`,
    `HTTP ${back.status}, ${back.bytes.byteLength} bytes`,
  );

  const wrongUpload = await client.upload(
    WRONG_ACCOUNT_ID,
    notesBytes,
    "text/plain",
  );
  report.check(
    `${step}: upload to another account is refused`,
    wrongUpload.status === 403,
    "403",
    `HTTP ${wrongUpload.status}: ${wrongUpload.text.slice(0, 200)}`,
  );
  const accountsToRefuse = [WRONG_ACCOUNT_ID];
  if (config.oldAccountId) accountsToRefuse.push(config.oldAccountId);
  for (const accountId of accountsToRefuse) {
    const refused = await client.download(
      accountId,
      uploads.png.blobId,
      "logo.png",
      "image/png",
    );
    report.check(
      `${step}: download through account ${accountId.slice(0, 8)}… is 404`,
      refused.status === 404,
      "404",
      `HTTP ${refused.status}`,
    );
  }
  return uploads;
}

async function stepDraft(ctx, env, blobs) {
  const { client, report } = ctx;
  const step = "3 draft";
  const subject = `${ctx.marker} draft`;
  const responses = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: { draft: draftEmail(ctx, env, blobs, { subject }) },
      },
      "set",
    ],
    emailGet(env, "get"),
  ]);
  const set = methodResponse(responses, "Email/set", "set");
  const created = set.created?.draft;
  if (!created) {
    report.fail(`${step}: Email/set create`, JSON.stringify(set.notCreated));
  }
  ctx.liveDrafts.add(created.id);
  report.check(
    `${step}: create returns id, blobId, threadId and size`,
    created.id.startsWith("D") &&
      typeof created.blobId === "string" &&
      created.blobId.startsWith("X") &&
      typeof created.threadId === "string" &&
      Number.isInteger(created.size) &&
      created.size > 0,
    `${created.id}, ${created.blobId}, ${created.size} bytes`,
    JSON.stringify(created),
  );

  const email = methodResponse(responses, "Email/get", "get").list[0];
  if (!email)
    report.fail(`${step}: Email/get #draft`, "the new draft was not returned");
  report.check(
    `${step}: draft mailbox, keywords, blob and size`,
    stableStringify(email.mailboxIds) ===
      stableStringify({ [env.draftsMailboxId]: true }) &&
      stableStringify(email.keywords) ===
        stableStringify({ $draft: true, $seen: true }) &&
      email.blobId === created.blobId &&
      email.size === created.size,
    "",
    JSON.stringify({
      mailboxIds: email.mailboxIds,
      keywords: email.keywords,
      blobId: email.blobId,
    }),
  );
  const inline = email.attachments.find((part) => part.name === "logo.png");
  const notes = email.attachments.find((part) => part.name === "notes.txt");
  report.check(
    `${step}: attachments keep name, type, cid and disposition`,
    email.attachments.length === 2 &&
      inline?.cid === INLINE_CID &&
      inline?.disposition === "inline" &&
      inline?.type === "image/png" &&
      notes?.disposition === "attachment" &&
      notes?.type.startsWith("text/plain"),
    "",
    JSON.stringify(email.attachments),
  );

  const raw = await client.download(
    env.accountId,
    created.blobId,
    "message.eml",
    "message/rfc822",
  );
  const rawText = new TextDecoder().decode(raw.bytes);
  report.check(
    `${step}: the X blob downloads with exactly size octets`,
    raw.status === 200 &&
      raw.bytes.byteLength === created.size &&
      /^message-id:/im.test(rawText) &&
      rawText.includes(ctx.marker),
    `${raw.bytes.byteLength} bytes`,
    `HTTP ${raw.status}, ${raw.bytes.byteLength} bytes for size ${created.size}`,
  );

  const textPart = email.textBody[0];
  const textDownload = await client.download(
    env.accountId,
    textPart.blobId,
    "body.txt",
    "text/plain",
  );
  report.check(
    `${step}: the text P part downloads`,
    textPart.blobId.startsWith(`P${email.id}_`) &&
      textDownload.status === 200 &&
      textPart.size === textDownload.bytes.byteLength &&
      bodyValueMatches(
        textDownload.bytes,
        email.bodyValues[textPart.partId]?.value,
      ),
    `${textPart.blobId}, ${textDownload.bytes.byteLength} bytes`,
    `HTTP ${textDownload.status} for ${textPart.blobId}, ${textDownload.bytes.byteLength} bytes, size ${textPart.size}`,
  );
  for (const [part, expected] of [
    [inline, PNG_BYTES],
    [notes, blobs.notes.bytes],
  ]) {
    const got = await client.download(
      env.accountId,
      part.blobId,
      part.name,
      part.type,
    );
    report.check(
      `${step}: the attachment part ${part.name} downloads byte-identical`,
      part.blobId.startsWith(`P${email.id}_`) &&
        got.status === 200 &&
        bytesEqual(got.bytes, expected) &&
        part.size === expected.byteLength,
      part.blobId,
      `HTTP ${got.status}, ${got.bytes.byteLength} bytes, size ${part.size}`,
    );
  }

  const destroyResponses = await client.call([
    ["Email/set", { accountId: env.accountId, destroy: [created.id] }, "x"],
    [
      "Email/get",
      { accountId: env.accountId, ids: [created.id], properties: ["id"] },
      "g",
    ],
  ]);
  const destroyed = methodResponse(destroyResponses, "Email/set", "x");
  const gone = methodResponse(destroyResponses, "Email/get", "g");
  report.check(
    `${step}: destroy removes the draft`,
    (destroyed.destroyed ?? []).includes(created.id) &&
      gone.notFound.includes(created.id),
    "",
    JSON.stringify({
      destroyed: destroyed.destroyed,
      notDestroyed: destroyed.notDestroyed,
      notFound: gone.notFound,
    }),
  );
  ctx.liveDrafts.delete(created.id);
}

async function stepRfcFlow(ctx, env, blobs) {
  const { client, report } = ctx;
  const step = "4 RFC 8621 §7.5 flow";
  const subject = `${ctx.marker} rfc-flow`;
  const responses = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: { draft: draftEmail(ctx, env, blobs, { subject }) },
      },
      "0",
    ],
    emailGet(env, "1"),
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: { sub: { emailId: "#draft", identityId: env.identity.id } },
        onSuccessUpdateEmail: {
          "#sub": {
            "keywords/$draft": null,
            [`mailboxIds/${env.draftsMailboxId}`]: null,
            [`mailboxIds/${env.sentMailboxId}`]: true,
          },
        },
      },
      "2",
    ],
    emailGet(env, "3"),
  ]);

  const created = methodResponse(responses, "Email/set", "0").created?.draft;
  if (!created) {
    report.fail(
      `${step}: draft create`,
      JSON.stringify(methodResponse(responses, "Email/set", "0").notCreated),
    );
  }
  ctx.liveDrafts.add(created.id);

  const order = responses.map(([name, , callId]) => `${name}:${callId}`);
  report.check(
    `${step}: responses, with the implicit Email/set after EmailSubmission/set`,
    stableStringify(order) ===
      stableStringify([
        "Email/set:0",
        "Email/get:1",
        "EmailSubmission/set:2",
        "Email/set:2",
        "Email/get:3",
      ]),
    order.join(" "),
    order.join(" "),
  );

  const submissionSet = methodResponse(responses, "EmailSubmission/set", "2");
  const submission = submissionSet.created?.sub;
  if (!submission) {
    report.fail(
      `${step}: EmailSubmission/set create`,
      JSON.stringify(submissionSet.notCreated),
    );
  }
  report.check(
    `${step}: submission accepted`,
    submission.id.startsWith("E"),
    submission.id,
    JSON.stringify(submission),
  );

  const implicit = responses.find(
    ([name, , callId]) => name === "Email/set" && callId === "2",
  )?.[1];
  report.check(
    `${step}: the implicit Email/set updated the draft`,
    Boolean(implicit) &&
      Object.prototype.hasOwnProperty.call(
        implicit.updated ?? {},
        created.id,
      ) &&
      !implicit.notUpdated,
    "",
    JSON.stringify(implicit),
  );
  ctx.liveDrafts.delete(created.id);

  const before = methodResponse(responses, "Email/get", "1").list[0];
  const after = methodResponse(responses, "Email/get", "3").list[0];
  if (!before || !after) {
    report.fail(
      `${step}: Email/get before and after`,
      JSON.stringify({ before, after }),
    );
  }
  report.check(
    `${step}: the same id before and after`,
    before.id === created.id && after.id === created.id,
    created.id,
    `${before.id} → ${after.id}`,
  );
  report.check(
    `${step}: filed into Sent, $draft removed`,
    stableStringify(after.mailboxIds) ===
      stableStringify({ [env.sentMailboxId]: true }) &&
      stableStringify(after.keywords) === stableStringify({ $seen: true }),
    "",
    JSON.stringify({ mailboxIds: after.mailboxIds, keywords: after.keywords }),
  );
  const changed = immutableDifferences(before, after);
  report.check(
    `${step}: immutable properties unchanged`,
    changed.length === 0,
    `${IMMUTABLE_EMAIL_PROPERTIES.length} properties compared`,
    `changed: ${changed.join(", ")}`,
  );

  return {
    subject,
    emailId: created.id,
    submissionId: submission.id,
    before,
    after,
  };
}

async function stepSent(ctx, env, sent) {
  const { client, report, config } = ctx;
  const step = "5 Sent";
  const inSent = await sentEmailsWithSubject(ctx, env, sent.subject);
  report.check(
    `${step}: the draft id is listed in Sent, exactly once`,
    inSent.length === 1 && inSent[0].id === sent.emailId,
    sent.emailId,
    JSON.stringify(inSent.map((email) => email.id)),
  );

  const responses = await client.call([
    [
      "EmailSubmission/get",
      { accountId: env.accountId, ids: [sent.submissionId] },
      "s",
    ],
  ]);
  const record = methodResponse(responses, "EmailSubmission/get", "s").list[0];
  report.check(
    `${step}: the submission record`,
    record?.emailId === sent.emailId &&
      record.identityId === env.identity.id &&
      record.threadId === sent.before.threadId &&
      record.undoStatus === "final" &&
      record.deliveryStatus === null &&
      typeof record.sendAt === "string",
    `sendAt ${record?.sendAt}`,
    JSON.stringify(record),
  );

  const raw = await client.download(
    env.accountId,
    sent.after.blobId,
    "sent.eml",
    "message/rfc822",
  );
  report.check(
    `${step}: the raw blob still downloads`,
    raw.status === 200 && raw.bytes.byteLength === sent.after.size,
    `${raw.bytes.byteLength} bytes`,
    `HTTP ${raw.status}, ${raw.bytes.byteLength} bytes for size ${sent.after.size}`,
  );

  if (!config.expectDelivery) {
    report.skip(
      `${step}: delivery`,
      "set JMAP_EXPECT_DELIVERY=1 when this key can read JMAP_TO's inbox",
    );
    return null;
  }
  const delivered = await awaitDelivery(ctx, env, step, sent.subject);
  // The Sent Email keeps its own messageId (immutable); a provider may deliver
  // the message under its own. Step 5b checks what matters: threading.
  const own = sent.after.messageId?.[0];
  const wire = delivered.messageId?.[0];
  report.check(
    `${step}: the delivered Message-ID`,
    typeof wire === "string" && wire.length > 0,
    wire === own
      ? `the Sent Email's own: ${wire}`
      : `provider-assigned: ${wire} (the Sent Email keeps ${own})`,
    JSON.stringify(delivered.messageId),
  );
  report.check(
    `${step}: the delivered From is ${config.from}`,
    delivered.from?.[0]?.email?.toLowerCase() === config.from,
    "",
    JSON.stringify(delivered.from),
  );
  // The inline image is found by its Content-ID, not its name: Cloudflare
  // drops the filename of inline parts (the cid, type and bytes survive).
  const parts = delivered.attachments ?? [];
  const inline = parts.find(
    (part) => part.cid?.replace(/^<|>$/g, "") === INLINE_CID,
  );
  const notes = parts.find((part) => part.name === "notes.txt");
  report.check(
    `${step}: the delivered attachments, with the inline cid`,
    inline?.type === "image/png" &&
      inline.size === PNG_BYTES.byteLength &&
      // Still text/plain: Cloudflare appends a line break to text parts, and
      // saasmail must not "fix" that by disguising them as octet-streams.
      notes?.type === "text/plain",
    `${inline?.name ?? "?"} (cid ${INLINE_CID}), notes.txt`,
    JSON.stringify(parts),
  );
  return delivered;
}

/**
 * A follow-up to the Sent Email, citing its `messageId` as a JMAP client does.
 * It joins the Sent Email's thread, and on the wire it must cite the Message-ID
 * the first message was delivered with, so the recipient's client threads it.
 */
async function stepFollowUp(ctx, env, blobs, sent, deliveredOriginal) {
  const { client, report } = ctx;
  const step = "5b follow-up";
  if (!deliveredOriginal) {
    report.skip(`${step}: threading`, "needs JMAP_EXPECT_DELIVERY=1");
    return;
  }
  const subject = `${ctx.marker} follow-up`;
  const draft = draftEmail(ctx, env, blobs, { subject });
  draft.inReplyTo = sent.after.messageId;
  draft.references = [...draft.references, ...sent.after.messageId];
  const responses = await client.call([
    ["Email/set", { accountId: env.accountId, create: { draft } }, "0"],
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: { sub: { emailId: "#draft", identityId: env.identity.id } },
        onSuccessDestroyEmail: ["#sub"],
      },
      "1",
    ],
  ]);
  const created = methodResponse(responses, "Email/set", "0").created?.draft;
  if (!created) {
    report.fail(
      `${step}: draft create`,
      JSON.stringify(methodResponse(responses, "Email/set", "0").notCreated),
    );
  }
  ctx.liveDrafts.add(created.id);
  const submitted = methodResponse(responses, "EmailSubmission/set", "1")
    .created?.sub;
  if (!submitted) {
    report.fail(
      `${step}: submission`,
      JSON.stringify(
        methodResponse(responses, "EmailSubmission/set", "1").notCreated,
      ),
    );
  }
  ctx.liveDrafts.delete(created.id);
  report.check(
    `${step}: the follow-up joins the Sent Email's thread`,
    created.threadId === sent.after.threadId,
    created.threadId,
    `${created.threadId} vs ${sent.after.threadId}`,
  );

  const delivered = await awaitDelivery(ctx, env, step, subject);
  report.check(
    `${step}: it cites the Message-ID the first message was delivered with`,
    citesDeliveredOriginal(delivered, deliveredOriginal),
    deliveredOriginal.messageId[0],
    JSON.stringify({
      inReplyTo: delivered.inReplyTo,
      references: delivered.references,
      original: deliveredOriginal.messageId,
    }),
  );
}

async function stepDestroyVariant(ctx, env, blobs) {
  const { client, report } = ctx;
  const step = "6a onSuccessDestroyEmail";
  const subject = `${ctx.marker} destroy`;
  const responses = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: { draft: draftEmail(ctx, env, blobs, { subject }) },
      },
      "0",
    ],
    emailGet(env, "1"),
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: { sub: { emailId: "#draft", identityId: env.identity.id } },
        onSuccessDestroyEmail: ["#sub"],
      },
      "2",
    ],
    [
      "Email/get",
      { accountId: env.accountId, ids: ["#draft"], properties: ["id"] },
      "3",
    ],
  ]);
  const created = methodResponse(responses, "Email/set", "0").created?.draft;
  if (!created) report.fail(`${step}: draft create`, "not created");
  ctx.liveDrafts.add(created.id);
  const submission = methodResponse(responses, "EmailSubmission/set", "2")
    .created?.sub;
  if (!submission) {
    report.fail(
      `${step}: submission`,
      JSON.stringify(
        methodResponse(responses, "EmailSubmission/set", "2").notCreated,
      ),
    );
  }
  const implicit = responses.find(
    ([name, , callId]) => name === "Email/set" && callId === "2",
  )?.[1];
  const gone = methodResponse(responses, "Email/get", "3");
  report.check(
    `${step}: the draft was destroyed`,
    (implicit?.destroyed ?? []).includes(created.id) &&
      gone.notFound.includes(created.id),
    created.id,
    JSON.stringify({ implicit, notFound: gone.notFound }),
  );
  ctx.liveDrafts.delete(created.id);

  const before = methodResponse(responses, "Email/get", "1").list[0];
  const copies = await sentEmailsWithSubject(ctx, env, subject);
  report.check(
    `${step}: one S… Email in Sent`,
    copies.length === 1 && copies[0].id.startsWith("S"),
    copies[0]?.id,
    JSON.stringify(copies.map((email) => email.id)),
  );
  const copy = copies[0];
  const changed = immutableDifferences(before, copy, {
    ignore: ["receivedAt"],
  });
  report.check(
    `${step}: the S… has the draft's immutable properties`,
    changed.length === 0 &&
      stableStringify(copy.mailboxIds) ===
        stableStringify({ [env.sentMailboxId]: true }),
    "receivedAt is the send time",
    `changed: ${changed.join(", ")}; mailboxIds ${JSON.stringify(copy.mailboxIds)}`,
  );
  const raw = await client.download(
    env.accountId,
    copy.blobId,
    "sent.eml",
    "message/rfc822",
  );
  report.check(
    `${step}: the S… blob downloads`,
    raw.status === 200 && raw.bytes.byteLength === copy.size,
    `${raw.bytes.byteLength} bytes`,
    `HTTP ${raw.status}`,
  );
  const records = await client.call([
    [
      "EmailSubmission/get",
      { accountId: env.accountId, ids: [submission.id] },
      "s",
    ],
  ]);
  const record = methodResponse(records, "EmailSubmission/get", "s").list[0];
  report.check(
    `${step}: the submission still names the destroyed draft`,
    record?.emailId === created.id,
    created.id,
    JSON.stringify(record),
  );
}

async function stepFlagVariant(ctx, env, blobs) {
  const { client, report } = ctx;
  const step = "6b flag-only onSuccessUpdateEmail";
  const subject = `${ctx.marker} flag`;
  const responses = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: { draft: draftEmail(ctx, env, blobs, { subject }) },
      },
      "0",
    ],
    emailGet(env, "1"),
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: { sub: { emailId: "#draft", identityId: env.identity.id } },
        onSuccessUpdateEmail: { "#sub": { "keywords/$flagged": true } },
      },
      "2",
    ],
    emailGet(env, "3"),
  ]);
  const created = methodResponse(responses, "Email/set", "0").created?.draft;
  if (!created) report.fail(`${step}: draft create`, "not created");
  ctx.liveDrafts.add(created.id);
  if (!methodResponse(responses, "EmailSubmission/set", "2").created?.sub) {
    report.fail(
      `${step}: submission`,
      JSON.stringify(
        methodResponse(responses, "EmailSubmission/set", "2").notCreated,
      ),
    );
  }
  const after = methodResponse(responses, "Email/get", "3").list[0];
  report.check(
    `${step}: the draft stays in Drafts, flagged`,
    stableStringify(after?.mailboxIds) ===
      stableStringify({ [env.draftsMailboxId]: true }) &&
      stableStringify(after?.keywords) ===
        stableStringify({ $draft: true, $seen: true, $flagged: true }),
    created.id,
    JSON.stringify({
      mailboxIds: after?.mailboxIds,
      keywords: after?.keywords,
    }),
  );

  const before = methodResponse(responses, "Email/get", "1").list[0];
  const copies = await sentEmailsWithSubject(ctx, env, subject);
  report.check(
    `${step}: the S… is revealed in Sent, unflagged`,
    copies.length === 1 &&
      copies[0].id.startsWith("S") &&
      stableStringify(copies[0].keywords) === stableStringify({ $seen: true }),
    copies[0]?.id,
    JSON.stringify(
      copies.map((email) => ({ id: email.id, keywords: email.keywords })),
    ),
  );
  const changed = immutableDifferences(before, copies[0], {
    ignore: ["receivedAt"],
  });
  report.check(
    `${step}: the S… has the draft's immutable properties`,
    changed.length === 0,
    "",
    `changed: ${changed.join(", ")}`,
  );

  const destroyed = methodResponse(
    await client.call([
      ["Email/set", { accountId: env.accountId, destroy: [created.id] }, "x"],
    ]),
    "Email/set",
    "x",
  );
  report.check(
    `${step}: the sent draft is still there and destroyable`,
    (destroyed.destroyed ?? []).includes(created.id),
    "",
    JSON.stringify(destroyed.notDestroyed),
  );
  ctx.liveDrafts.delete(created.id);
}

/**
 * Several To and a Bcc in one send: JMAP_TO and JMAP_CC (when set) as To, the
 * sending address itself as Bcc (its saasmail inbox is readable with this key).
 */
async function stepMultiRecipient(ctx, env, blobs) {
  const { client, report, config } = ctx;
  const step = "7 several To and Bcc";
  const subject = `${ctx.marker} multi`;
  const to = [
    recipient(config.to),
    ...(config.cc ? [recipient(config.cc, "Second To")] : []),
  ];
  const bcc = [recipient(config.from, "Hidden Bcc")];
  const responses = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: {
          draft: draftEmail(ctx, env, blobs, { subject, to, cc: [], bcc }),
        },
      },
      "0",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: { sub: { emailId: "#draft", identityId: env.identity.id } },
        onSuccessDestroyEmail: ["#sub"],
      },
      "1",
    ],
  ]);
  const created = methodResponse(responses, "Email/set", "0").created?.draft;
  if (!created) {
    report.fail(
      `${step}: draft create`,
      JSON.stringify(methodResponse(responses, "Email/set", "0").notCreated),
    );
  }
  ctx.liveDrafts.add(created.id);
  const submissions = methodResponse(responses, "EmailSubmission/set", "1");
  if (!submissions.created?.sub) {
    report.fail(`${step}: submission`, JSON.stringify(submissions.notCreated));
  }
  ctx.liveDrafts.delete(created.id);
  report.pass(`${step}: accepted`, `${to.length} To, 1 Bcc`);

  const [sent] = await sentEmailsWithSubject(ctx, env, subject);
  report.check(
    `${step}: the Sent Email keeps every To and the Bcc`,
    stableStringify((sent?.to ?? []).map((a) => a.email.toLowerCase())) ===
      stableStringify(to.map((a) => a.email)) &&
      stableStringify((sent?.bcc ?? []).map((a) => a.email.toLowerCase())) ===
        stableStringify([config.from]),
    sent?.id ?? "?",
    JSON.stringify({ to: sent?.to, bcc: sent?.bcc }),
  );

  if (!config.expectDelivery) {
    report.skip(`${step}: delivery`, "needs JMAP_EXPECT_DELIVERY=1");
    return;
  }
  const atTo = await awaitDelivery(ctx, env, step, subject);
  const visible = (atTo.to ?? []).map((a) => a.email.toLowerCase());
  report.check(
    `${step}: the To copy lists every To and not the Bcc`,
    to.every((a) => visible.includes(a.email)) &&
      !visible.includes(config.from),
    visible.join(", "),
    JSON.stringify(atTo.to),
  );
  await awaitDelivery(ctx, env, step, subject, config.from);
}

async function stepDelayed(ctx, env, blobs) {
  const { client, report, config } = ctx;
  const step = "9 delayed send";
  const intoSent = {
    "keywords/$draft": null,
    [`mailboxIds/${env.draftsMailboxId}`]: null,
    [`mailboxIds/${env.sentMailboxId}`]: true,
  };
  const schedule = (subject, parameters) => [
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: { draft: draftEmail(ctx, env, blobs, { subject }) },
      },
      "0",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: {
          sub: {
            emailId: "#draft",
            identityId: env.identity.id,
            envelope: {
              mailFrom: { email: env.identity.email, parameters },
              rcptTo: [config.to, ...(config.cc ? [config.cc] : [])].map(
                (email) => ({ email }),
              ),
            },
          },
        },
        onSuccessUpdateEmail: { "#sub": intoSent },
      },
      "1",
    ],
  ];

  // A one-hour hold: scheduled, filed into Sent now, canceled, moved back.
  const held = await client.call(
    schedule(`${ctx.marker} held`, { HOLDFOR: "3600" }),
  );
  const draft = methodResponse(held, "Email/set", "0").created?.draft;
  if (!draft) {
    report.fail(`${step}: draft create`, JSON.stringify(held));
  }
  ctx.liveDrafts.add(draft.id);
  const submission = methodResponse(held, "EmailSubmission/set", "1").created
    ?.sub;
  const sendAt = Date.parse(submission?.sendAt ?? "");
  report.check(
    `${step}: HOLDFOR=3600 is scheduled, undoStatus pending`,
    submission?.undoStatus === "pending" &&
      Math.abs(sendAt - (Date.now() + 3600_000)) < 5 * 60_000,
    submission?.sendAt ?? "",
    JSON.stringify(methodResponse(held, "EmailSubmission/set", "1")),
  );
  ctx.liveDrafts.delete(draft.id);
  const filed = await client.call([
    emailGet(env, "g", [draft.id]),
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        update: { [submission.id]: { undoStatus: "canceled" } },
      },
      "c",
    ],
    [
      "EmailSubmission/get",
      { accountId: env.accountId, ids: [submission.id] },
      "r",
    ],
  ]);
  report.check(
    `${step}: the same Email is in Sent before it goes out`,
    stableStringify(
      methodResponse(filed, "Email/get", "g").list[0]?.mailboxIds,
    ) === stableStringify({ [env.sentMailboxId]: true }),
    draft.id,
    JSON.stringify(methodResponse(filed, "Email/get", "g")),
  );
  report.check(
    `${step}: cancel while scheduled`,
    Object.prototype.hasOwnProperty.call(
      methodResponse(filed, "EmailSubmission/set", "c").updated ?? {},
      submission.id,
    ) &&
      methodResponse(filed, "EmailSubmission/get", "r").list[0]?.undoStatus ===
        "canceled",
    "",
    JSON.stringify(filed),
  );
  const back = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        update: {
          [draft.id]: {
            mailboxIds: { [env.draftsMailboxId]: true },
            keywords: { $draft: true, $seen: true },
          },
        },
      },
      "b",
    ],
    emailGet(env, "g", [draft.id]),
  ]);
  const restored = methodResponse(back, "Email/get", "g").list[0];
  report.check(
    `${step}: the canceled Email moves back to Drafts under the same id`,
    restored?.id === draft.id &&
      stableStringify(restored?.mailboxIds) ===
        stableStringify({ [env.draftsMailboxId]: true }) &&
      restored?.keywords?.$draft === true,
    draft.id,
    JSON.stringify(back),
  );
  ctx.liveDrafts.add(draft.id);

  // A hold past maxDelayedSend is refused.
  const tooLong = await client.call([
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: {
          sub: {
            emailId: draft.id,
            identityId: env.identity.id,
            envelope: {
              mailFrom: {
                email: env.identity.email,
                parameters: { HOLDFOR: String(MAX_DELAYED_SEND + 1) },
              },
              rcptTo: [config.to, ...(config.cc ? [config.cc] : [])].map(
                (email) => ({ email }),
              ),
            },
          },
        },
      },
      "x",
    ],
  ]);
  report.check(
    `${step}: HOLDFOR past maxDelayedSend is refused`,
    methodResponse(tooLong, "EmailSubmission/set", "x").notCreated?.sub
      ?.type === "invalidProperties",
    "",
    JSON.stringify(tooLong),
  );

  // A short hold really goes out: the queue releases it and undoStatus turns
  // final. This sends one more real email.
  const short = await client.call(
    schedule(`${ctx.marker} released`, { HOLDFOR: "20" }),
  );
  const shortDraft = methodResponse(short, "Email/set", "0").created?.draft;
  const shortSubmission = methodResponse(short, "EmailSubmission/set", "1")
    .created?.sub;
  if (!shortDraft || !shortSubmission) {
    report.fail(`${step}: short hold`, JSON.stringify(short));
  }
  const deadline = Date.now() + config.deliveryTimeoutSeconds * 1000;
  let undoStatus = "pending";
  while (undoStatus === "pending" && Date.now() < deadline) {
    await ctx.sleep(5000);
    const read = await client.call([
      [
        "EmailSubmission/get",
        { accountId: env.accountId, ids: [shortSubmission.id] },
        "r",
      ],
    ]);
    undoStatus =
      methodResponse(read, "EmailSubmission/get", "r").list[0]?.undoStatus ??
      "missing";
  }
  report.check(
    `${step}: HOLDFOR=20 is released by the queue and becomes final`,
    undoStatus === "final",
    shortSubmission.id,
    `undoStatus ${undoStatus} after ${config.deliveryTimeoutSeconds}s`,
  );
  if (config.expectDelivery) {
    await awaitDelivery(ctx, env, step, `${ctx.marker} released`);
  }
}

async function stepNegative(ctx, env, blobs) {
  const { client, report } = ctx;
  const step = "8 negative";
  const cc = Array.from({ length: 50 }, (_, i) =>
    recipient(`r${i}-${ctx.marker}@jmap-e2e.invalid`, null),
  );
  const responses = await client.call([
    [
      "Email/set",
      {
        accountId: env.accountId,
        create: {
          dMany: draftEmail(ctx, env, blobs, {
            subject: `${ctx.marker} too-many`,
            cc,
          }),
        },
      },
      "0",
    ],
    [
      "EmailSubmission/set",
      {
        accountId: env.accountId,
        create: { sMany: { emailId: "#dMany", identityId: env.identity.id } },
      },
      "1",
    ],
  ]);
  const draft = methodResponse(responses, "Email/set", "0").created?.dMany;
  if (!draft) report.fail(`${step}: draft`, "not created");
  ctx.liveDrafts.add(draft.id);
  const submissions = methodResponse(responses, "EmailSubmission/set", "1");
  const error = submissions.notCreated?.sMany;
  report.check(
    `${step}: 51 recipients → tooManyRecipients (50)`,
    error?.type === "tooManyRecipients" && error.maxRecipients === 50,
    "",
    JSON.stringify(error),
  );
  report.check(
    `${step}: nothing was accepted`,
    !submissions.created &&
      !responses.some(
        ([name, , callId]) => name === "Email/set" && callId === "1",
      ),
    "",
    JSON.stringify(submissions.created),
  );
  const leaked = await sentEmailsWithSubject(
    ctx,
    env,
    `${ctx.marker} too-many`,
  );
  report.check(
    `${step}: no Sent Email for the refused draft`,
    leaked.length === 0,
    "",
    JSON.stringify(leaked.map((email) => email.id)),
  );
  const destroyed = methodResponse(
    await client.call([
      ["Email/set", { accountId: env.accountId, destroy: [draft.id] }, "x"],
    ]),
    "Email/set",
    "x",
  );
  report.check(
    `${step}: the refused draft is destroyable`,
    (destroyed.destroyed ?? []).includes(draft.id),
    "",
    JSON.stringify(destroyed.notDestroyed),
  );
  ctx.liveDrafts.delete(draft.id);
}

/** Destroy drafts this run created and did not already remove. */
async function cleanupDrafts(ctx) {
  if (!ctx.accountId || ctx.liveDrafts.size === 0) return;
  const ids = [...ctx.liveDrafts];
  try {
    const result = methodResponse(
      await ctx.client.call([
        ["Email/set", { accountId: ctx.accountId, destroy: ids }, "cleanup"],
      ]),
      "Email/set",
      "cleanup",
    );
    const left = Object.keys(result.notDestroyed ?? {});
    if (left.length > 0) {
      ctx.report.warn(
        "cleanup",
        `drafts left behind: ${JSON.stringify(result.notDestroyed)}`,
      );
    } else {
      ctx.log(`cleanup: destroyed ${ids.length} draft(s) this run created`);
    }
  } catch (error) {
    ctx.report.warn(
      "cleanup",
      `could not destroy ${ids.join(", ")}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export async function run(
  config,
  {
    fetchImpl = globalThis.fetch,
    log = console.log,
    sleep = defaultSleep,
  } = {},
) {
  const report = createReporter(log);
  const ctx = {
    config,
    client: createClient(config, fetchImpl),
    report,
    log,
    sleep,
    marker: `jmap-e2e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    // Query window for this run's messages; five minutes absorbs clock skew.
    windowStart: new Date(Date.now() - 5 * 60_000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "Z"),
    accountId: null,
    liveDrafts: new Set(),
  };
  log(`run marker: ${ctx.marker}`);

  let failure = null;
  try {
    const env = await stepSession(ctx);
    const blobs = await stepUpload(ctx, env);
    await stepDraft(ctx, env, blobs);
    const sent = await stepRfcFlow(ctx, env, blobs);
    const delivered = await stepSent(ctx, env, sent);
    await stepFollowUp(ctx, env, blobs, sent, delivered);
    await stepDestroyVariant(ctx, env, blobs);
    await stepFlagVariant(ctx, env, blobs);
    await stepMultiRecipient(ctx, env, blobs);
    await stepDelayed(ctx, env, blobs);
    await stepNegative(ctx, env, blobs);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    if (!(error instanceof CheckFailed)) {
      log(
        `FAIL  unexpected error: ${error instanceof Error ? error.stack : failure}`,
      );
    }
  }
  await cleanupDrafts(ctx);

  if (failure) {
    log(`\nFAILED after ${report.passed} passing checks: ${failure}`);
    return { ok: false, passed: report.passed, failure };
  }
  log(`\nALL ${report.passed} CHECKS PASSED (marker ${ctx.marker})`);
  return { ok: true, passed: report.passed };
}

async function main() {
  const parsed = readConfig(process.env);
  if (parsed.error) {
    console.error(`jmap-send-e2e: ${parsed.error}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const { config } = parsed;
  console.log(
    `jmap-send-e2e: ${config.baseUrl}, ${config.from} → ${config.to}${
      config.cc ? ` (cc ${config.cc})` : ""
    }. This sends real email.`,
  );
  const result = await run(config);
  process.exitCode = result.ok ? 0 : 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  });
}
