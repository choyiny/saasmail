import { isSuppressed, type Database } from "./suppressions";
import { signToken } from "./unsubscribe-token";
import type {
  EmailSender,
  SendEmailParams,
  SendEmailResult,
} from "./email-sender";

export interface SendInput {
  db: Database;
  env: { UNSUBSCRIBE_SECRET: string; BASE_URL: string };
  sender: EmailSender;
  from: SendEmailParams["from"];
  to: string;
  cc?: string[];
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
    headers,
    attachments,
    transactional,
  } = input;
  let { html, text } = input;

  // Partition recipients into delivered vs suppressed. Transactional sends
  // bypass the suppression list entirely.
  let primaryTo: string | null;
  const deliveredCc: string[] = [];
  const suppressed: string[] = [];

  if (transactional === true) {
    primaryTo = to;
    if (cc && cc.length > 0) deliveredCc.push(...cc);
  } else {
    primaryTo = (await isSuppressed(db, to)) ? null : to;
    if (primaryTo === null) suppressed.push(to);

    if (cc) {
      for (const addr of cc) {
        if (await isSuppressed(db, addr)) {
          suppressed.push(addr);
        } else {
          deliveredCc.push(addr);
        }
      }
    }

    // If the primary `to` was suppressed, promote the first surviving cc to
    // be the new `to`; remaining cc stays in the cc list.
    if (primaryTo === null && deliveredCc.length > 0) {
      primaryTo = deliveredCc.shift() as string;
    }
  }

  // Nothing to send if every recipient was suppressed.
  if (primaryTo === null) {
    return { delivered: [], suppressed };
  }

  let finalHeaders: Record<string, string> | undefined = headers
    ? { ...headers }
    : undefined;

  if (transactional !== true) {
    // Build the unsubscribe token from the FINAL primary recipient — the one
    // actually receiving the email as `to`. This ensures the recipient who
    // clicks unsubscribe is the one who gets suppressed.
    const token = await signToken(primaryTo, env.UNSUBSCRIBE_SECRET);
    const url = buildUnsubscribeUrl(env.BASE_URL, token);

    if (typeof html === "string") {
      html = html.replace(UNSUB_PLACEHOLDER, url);
      if (!html.includes(url)) {
        html = appendHtmlFooter(html, url);
      }
    }

    if (typeof text === "string") {
      text = text.replace(UNSUB_PLACEHOLDER, url);
      if (!text.includes(url)) {
        text = appendTextFooter(text, url);
      }
    }

    finalHeaders = {
      ...(headers ?? {}),
      "List-Unsubscribe": `<${url}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    };
  }

  const ccArg = deliveredCc.length > 0 ? deliveredCc : undefined;

  const result = await sender.send({
    from,
    to: primaryTo,
    ...(ccArg ? { cc: ccArg } : {}),
    subject,
    html: html ?? "",
    ...(text !== undefined ? { text } : {}),
    ...(finalHeaders ? { headers: finalHeaders } : {}),
    ...(attachments ? { attachments } : {}),
  });

  return {
    delivered: [primaryTo, ...deliveredCc],
    suppressed,
    result,
  };
}
