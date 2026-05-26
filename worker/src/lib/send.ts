import { isSuppressed, type Database } from "./suppressions";
import { signToken } from "./unsubscribe-token";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "./email-sender";

/**
 * A CC entry the caller hands us. We need the bare `email` for suppression
 * lookups AND for per-recipient token signing; the optional `name` is only
 * used when we format the final `"Name <addr>"` header value for the wire.
 */
export interface CcRecipient {
  email: string;
  name?: string | null;
}

export interface SendInput {
  db: Database;
  env: { UNSUBSCRIBE_SECRET: string; BASE_URL: string };
  sender: EmailSender;
  from: SendEmailParams["from"];
  to: string;
  cc?: CcRecipient[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  attachments?: SendEmailParams["attachments"];
  transactional?: boolean;
}

export interface SendOutput {
  delivered: string[];
  suppressed: string[];
  result?: SendEmailResult;
  /**
   * For audit logging: the rendered html/text actually sent to the FIRST
   * delivered recipient. For multi-recipient marketing sends each recipient
   * gets their own per-recipient token, so this is a representative copy of
   * one wire payload, not all of them.
   */
  renderedHtml?: string;
  renderedText?: string;
}

const UNSUB_PLACEHOLDER = /\{\{unsubscribe_url\}\}/g;

function buildUnsubscribeUrl(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/unsubscribe?token=${encodeURIComponent(
    token,
  )}`;
}

function appendHtmlFooter(html: string, url: string): string {
  return (
    html +
    `<hr/>\n<p style="font-size:12px;color:#666"><a href="${url}">Unsubscribe</a></p>`
  );
}

function appendTextFooter(text: string, url: string): string {
  return text + `\n\n---\nUnsubscribe: ${url}`;
}

/** Format a CcRecipient as a header-friendly `"Name <addr>"` string. */
function formatCcForTransport(c: CcRecipient): string {
  return c.name ? `${c.name} <${c.email}>` : c.email;
}

export async function sendWithSuppressionCheck(
  input: SendInput,
): Promise<SendOutput> {
  const {
    db,
    env,
    sender,
    from,
    to,
    cc,
    subject,
    html,
    text,
    headers,
    attachments,
    transactional,
  } = input;

  // Partition recipients into delivered vs suppressed. Transactional sends
  // bypass the suppression list entirely.
  let primaryTo: string | null;
  const deliveredCc: CcRecipient[] = [];
  const suppressed: string[] = [];

  if (transactional === true) {
    primaryTo = to;
    if (cc && cc.length > 0) deliveredCc.push(...cc);
  } else {
    primaryTo = (await isSuppressed(db, to)) ? null : to;
    if (primaryTo === null) suppressed.push(to);

    if (cc) {
      for (const entry of cc) {
        if (await isSuppressed(db, entry.email)) {
          suppressed.push(entry.email);
        } else {
          deliveredCc.push(entry);
        }
      }
    }

    // If the primary `to` was suppressed, promote the first surviving cc to
    // be the new `to`; remaining cc stays in the cc list.
    if (primaryTo === null && deliveredCc.length > 0) {
      const promoted = deliveredCc.shift()!;
      primaryTo = promoted.email;
    }
  }

  // Nothing to send if every recipient was suppressed.
  if (primaryTo === null) {
    return { delivered: [], suppressed };
  }

  let lastResult: SendEmailResult | undefined;
  let renderedHtml: string | undefined;
  let renderedText: string | undefined;

  if (transactional === true) {
    // Transactional: single transport call, no per-recipient personalization,
    // no List-Unsubscribe headers, no footer auto-append.
    const ccArg =
      deliveredCc.length > 0
        ? deliveredCc.map(formatCcForTransport)
        : undefined;

    lastResult = await sender.send({
      from,
      to: primaryTo,
      ...(ccArg ? { cc: ccArg } : {}),
      subject,
      html: html ?? "",
      ...(text !== undefined ? { text } : {}),
      ...(headers ? { headers } : {}),
      ...(attachments ? { attachments } : {}),
    });

    renderedHtml = html;
    renderedText = text;
  } else {
    // Marketing: one transport call per delivered recipient, each with its
    // own per-recipient unsubscribe token + headers + body interpolation.
    // Every recipient sees themselves as the sole `to` (no cc list), so
    // clicking the unsubscribe link suppresses them — not somebody else.
    const allDelivered: Array<{ email: string; cc?: CcRecipient }> = [
      { email: primaryTo },
      ...deliveredCc.map((c) => ({ email: c.email, cc: c })),
    ];

    const results = await Promise.all(
      allDelivered.map(async (recipient) => {
        const token = await signToken(recipient.email, env.UNSUBSCRIBE_SECRET);
        const url = buildUnsubscribeUrl(env.BASE_URL, token);

        let recipientHtml = html;
        let recipientText = text;
        if (typeof recipientHtml === "string") {
          recipientHtml = recipientHtml.replace(UNSUB_PLACEHOLDER, url);
          if (!recipientHtml.includes(url)) {
            recipientHtml = appendHtmlFooter(recipientHtml, url);
          }
        }
        if (typeof recipientText === "string") {
          recipientText = recipientText.replace(UNSUB_PLACEHOLDER, url);
          if (!recipientText.includes(url)) {
            recipientText = appendTextFooter(recipientText, url);
          }
        }

        const recipientHeaders: Record<string, string> = {
          ...(headers ?? {}),
          "List-Unsubscribe": `<${url}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        };

        // The header-formatted "to" is `"Name <addr>"` only when this entry
        // came from a cc with a display name; the original `to` is a bare
        // string by signature.
        const toForTransport = recipient.cc
          ? formatCcForTransport(recipient.cc)
          : recipient.email;

        const result = await sender.send({
          from,
          to: toForTransport,
          subject,
          html: recipientHtml ?? "",
          ...(recipientText !== undefined ? { text: recipientText } : {}),
          headers: recipientHeaders,
          ...(attachments ? { attachments } : {}),
        });

        return { result, recipientHtml, recipientText };
      }),
    );

    lastResult = results[0].result;
    renderedHtml = results[0].recipientHtml;
    renderedText = results[0].recipientText;
  }

  return {
    delivered: [primaryTo, ...deliveredCc.map((c) => c.email)],
    suppressed,
    result: lastResult,
    ...(renderedHtml !== undefined ? { renderedHtml } : {}),
    ...(renderedText !== undefined ? { renderedText } : {}),
  };
}
