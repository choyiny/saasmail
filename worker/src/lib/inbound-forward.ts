import { createEmailSender } from "./email-sender";
import { encodeDisplayName } from "./format-from-address";
import type {
  SendEmailAttachment,
  SendEmailParams,
} from "./email-sender/types";
import type {
  AuthResults,
  ParsedAttachment,
  ParsedEmailAddress,
} from "./email-parser";

/**
 * Per-inbox forwarding ("redirect rule").
 *
 * Why this exists instead of a Cloudflare Email Routing forwarding rule:
 * Email Routing relays forwarded mail from a shared IP pool, and Outlook /
 * Hotmail / Live blocklist parts of it. The bounce looks like:
 *
 *   permanent error (550): 5.7.1 Unfortunately, messages from [104.30.10.66]
 *   weren't sent ... part of their network is on our block list (S3150).
 *
 * That IP is Cloudflare's, not ours, so we can't get it delisted — anyone whose
 * personal mailbox is Microsoft-hosted just stops receiving forwards. Re-sending
 * the message ourselves through the configured outbound provider (Cloudflare
 * Email Sending / Resend / Bavimail / Postmark) leaves from different IPs and is
 * DKIM-signed for our own domain, so it authenticates cleanly.
 *
 * The consequence, and the central trade-off of this module: the forwarded copy
 * is a re-composition, not a byte-for-byte relay. We cannot keep the original
 * `From:` — sending as `customer@example.com` from our infrastructure fails SPF
 * and has no DKIM signature for that domain, so it fails DMARC and gets filtered
 * harder than the block we're routing around. Instead we send as the inbox, put
 * the real sender in `Reply-To`, and restate the original envelope in a header
 * block at the top of the body, the same way "forward as new message" works in
 * any mail client.
 */

/**
 * Trip-wire header stamped on every forward, used to break forwarding loops.
 *
 * Provider caveat: Bavimail's API has no generic custom-header field, so this
 * (and the two X- headers below) are dropped on that provider. Loop protection
 * there degrades to the self and same-instance destination checks, which still
 * cover the realistic cases; only the indirect "destination forwards back to us"
 * loop goes uncaught.
 */
export const FORWARD_LOOP_HEADER = "X-SaaSMail-Forwarded-For";

/** Traceability: ties a forwarded copy back to the inbound message it came from. */
export const FORWARD_ORIGINAL_MESSAGE_ID_HEADER =
  "X-SaaSMail-Original-Message-Id";

/** The real sender, preserved as a header as well as in Reply-To. */
export const FORWARD_ORIGINAL_FROM_HEADER = "X-SaaSMail-Original-From";

export type ForwardSkipReason =
  | "no-destination"
  | "loop-self"
  | "loop-known-inbox"
  | "loop-header";

export type BuildForwardResult =
  | { ok: true; message: SendEmailParams; skippedAttachments: string[] }
  | { ok: false; reason: ForwardSkipReason };

export interface BuildForwardMessageParams {
  /** Canonical (lowercased) inbox address the mail arrived at. */
  inbox: string;
  /** Configured destination, or null when forwarding is off for this inbox. */
  forwardTo: string | null;
  /** Display name configured for the inbox, used in the rewritten From. */
  inboxDisplayName: string | null;
  from: { address: string; name: string };
  subject: string;
  /** Untrimmed bodies — see `ParsedEmail.fullBodyHtml`. */
  fullBodyHtml: string | null;
  fullBodyText: string | null;
  messageId: string | null;
  /** Epoch seconds. */
  receivedAt: number;
  cc: ParsedEmailAddress[];
  auth: AuthResults;
  attachments: ParsedAttachment[];
  /** Inbound headers, lowercase-keyed (as produced by `parseEmail`). */
  headers: Record<string, string>;
  /** Every inbox address on this instance, lowercased. */
  knownInboxes: string[];
  /** Provider ceiling from `EmailSender.maxAttachmentBytes()`. */
  maxAttachmentBytes: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatAddress(address: string, name: string | null): string {
  return name ? `${name} <${address}>` : address;
}

/**
 * Decides whether an inbound message should be forwarded and, if so, builds the
 * outbound payload. Pure — no I/O — so the loop guards and header rewriting can
 * be tested without a live `ForwardableEmailMessage`.
 */
export function buildForwardMessage(
  params: BuildForwardMessageParams,
): BuildForwardResult {
  const destination = params.forwardTo?.trim().toLowerCase() ?? "";
  if (!destination) return { ok: false, reason: "no-destination" };

  const inbox = params.inbox.trim().toLowerCase();

  // Guard 1: forwarding an inbox to itself is an immediate tight loop.
  if (destination === inbox) return { ok: false, reason: "loop-self" };

  // Guard 2: the destination is another inbox on this instance, which would
  // bounce the message back through `handleEmail`. Checked here (not only at
  // config time) because an inbox can be created after the forward was set.
  if (params.knownInboxes.some((e) => e.trim().toLowerCase() === destination)) {
    return { ok: false, reason: "loop-known-inbox" };
  }

  // Guard 3: this message is itself a forward we (or another saasmail) emitted.
  // Breaks indirect loops where the destination auto-forwards back to us.
  const loopHeaderKey = FORWARD_LOOP_HEADER.toLowerCase();
  const seen = Object.keys(params.headers).some(
    (k) => k.toLowerCase() === loopHeaderKey,
  );
  if (seen) return { ok: false, reason: "loop-header" };

  const originalFrom = formatAddress(
    params.from.address,
    params.from.name || null,
  );

  // Send AS the inbox so the message authenticates on our own domain, but make
  // the real sender obvious in the From display name and replyable via Reply-To.
  const inboxLabel = params.inboxDisplayName || inbox;
  const fromLabel = params.from.name
    ? `${params.from.name} (via ${inboxLabel})`
    : `${params.from.address} (via ${inboxLabel})`;
  const from = `${encodeDisplayName(fromLabel)} <${inbox}>`;

  // Attachments are capped by the provider's ceiling. Anything that doesn't fit
  // is named in the body rather than silently dropped, so the recipient knows to
  // go look at the message in saasmail.
  const attachments: SendEmailAttachment[] = [];
  const skippedAttachments: string[] = [];
  let attachmentBytes = 0;
  for (const att of params.attachments) {
    const size = att.content.byteLength;
    if (attachmentBytes + size > params.maxAttachmentBytes) {
      skippedAttachments.push(att.filename);
      continue;
    }
    attachmentBytes += size;
    attachments.push({
      filename: att.filename,
      contentType: att.contentType,
      content: att.content,
    });
  }

  const subject = params.subject || "(no subject)";
  const dateLabel = new Date(params.receivedAt * 1000).toUTCString();
  const authLabel = `spf=${params.auth.spf ?? "none"} dkim=${
    params.auth.dkim ?? "none"
  } dmarc=${params.auth.dmarc ?? "none"}`;

  const headerLines: Array<[string, string]> = [
    ["From", originalFrom],
    ["Date", dateLabel],
    ["Subject", subject],
    ["To", inbox],
  ];
  if (params.cc.length > 0) {
    headerLines.push([
      "Cc",
      params.cc.map((c) => formatAddress(c.email, c.name)).join(", "),
    ]);
  }
  headerLines.push(["Authentication", authLabel]);

  const noteLines: string[] = [];
  if (skippedAttachments.length > 0) {
    noteLines.push(
      `${skippedAttachments.length} attachment(s) were too large to forward and are not included: ${skippedAttachments.join(", ")}`,
    );
  }

  const htmlHeaderBlock = [
    `<div style="font:13px/1.5 -apple-system,Segoe UI,sans-serif;color:#555;border-left:3px solid #ddd;padding:8px 12px;margin:0 0 16px">`,
    `<div style="font-weight:600;margin-bottom:6px">Forwarded by saasmail</div>`,
    ...headerLines.map(
      ([k, v]) =>
        `<div><span style="color:#888">${escapeHtml(k)}:</span> ${escapeHtml(v)}</div>`,
    ),
    ...noteLines.map(
      (n) => `<div style="margin-top:6px;color:#b45309">${escapeHtml(n)}</div>`,
    ),
    `</div>`,
  ].join("");

  const textHeaderBlock = [
    "---------- Forwarded by saasmail ----------",
    ...headerLines.map(([k, v]) => `${k}: ${v}`),
    ...noteLines,
    "",
    "",
  ].join("\n");

  // The original body is relayed verbatim, not sanitized. This is a mail relay,
  // not a page we render — the receiving mail client applies its own sandboxing,
  // and rewriting the body would defeat the point of forwarding. (saasmail's own
  // web view continues to render the sanitized, quote-trimmed copy.)
  const originalHtml = params.fullBodyHtml;
  const originalText = params.fullBodyText;

  const html = originalHtml
    ? `${htmlHeaderBlock}${originalHtml}`
    : originalText
      ? `${htmlHeaderBlock}<pre style="white-space:pre-wrap;font:inherit">${escapeHtml(originalText)}</pre>`
      : `${htmlHeaderBlock}<p style="color:#888"><em>(no message body)</em></p>`;

  const text = `${textHeaderBlock}${originalText ?? "(no message body)"}`;

  return {
    ok: true,
    skippedAttachments,
    message: {
      from,
      to: destination,
      subject,
      html,
      text,
      // Deliberately NOT forwarding the original Cc list as real recipients —
      // those are the sender's contacts, and re-sending to them would leak the
      // redirect and mail people who never opted into it. They appear in the
      // header block only.
      headers: {
        "Reply-To": params.from.address,
        [FORWARD_LOOP_HEADER]: inbox,
        [FORWARD_ORIGINAL_FROM_HEADER]: params.from.address,
        ...(params.messageId
          ? { [FORWARD_ORIGINAL_MESSAGE_ID_HEADER]: params.messageId }
          : {}),
      },
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

export interface ForwardInboundParams extends Omit<
  BuildForwardMessageParams,
  "knownInboxes" | "maxAttachmentBytes"
> {
  knownInboxes: string[];
}

/**
 * Fire-and-forget dispatch of the forwarded copy.
 *
 * Best-effort by design, mirroring `deliverWebhook`: it runs inside
 * `ctx.waitUntil` with its own try/catch, after the inbound message is already
 * durably stored, so a forwarding failure can never cost us the message.
 *
 * There is no retry. `sendViaOutbox` needs a `sent_emails` row id and reloads
 * attachments from R2 filtered on `kind = "sent"`; a forward has neither, and
 * synthesising one would put a duplicate of every inbound message into the Sent
 * views. Failures are logged instead.
 */
export function forwardInbound(
  env: CloudflareBindings,
  ctx: ExecutionContext,
  params: ForwardInboundParams,
): void {
  if (!params.forwardTo) return;

  ctx.waitUntil(
    (async () => {
      try {
        const sender = createEmailSender(env);
        const built = buildForwardMessage({
          ...params,
          maxAttachmentBytes: sender.maxAttachmentBytes(),
        });

        if (!built.ok) {
          console.warn(
            `Forward skipped for ${params.inbox} → ${params.forwardTo}: ${built.reason}`,
          );
          return;
        }

        // Sent via the raw sender rather than `sendWithSuppressionCheck` on
        // purpose: a relayed copy must not carry List-Unsubscribe headers or an
        // appended unsubscribe footer for a message saasmail didn't author, and
        // someone who unsubscribed from marketing must still receive their
        // forwarded support mail.
        const result = await sender.send(built.message);
        if (result.error) {
          console.error(
            `Forward failed for ${params.inbox} → ${built.message.to}: ${result.error.message}`,
          );
        } else if (built.skippedAttachments.length > 0) {
          console.warn(
            `Forwarded ${params.inbox} → ${built.message.to} without ${built.skippedAttachments.length} oversized attachment(s)`,
          );
        }
      } catch (err) {
        // Non-fatal: the message is already stored; forwarding is best-effort.
        console.error("Forward error:", err);
      }
    })(),
  );
}
