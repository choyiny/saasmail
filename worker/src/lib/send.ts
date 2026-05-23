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
  to: string[];
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
    `<hr/>\n<p style="font-size:12px;color:#666">You received this email because you're on our list. <a href="${url}">Unsubscribe</a></p>`
  );
}

function appendTextFooter(text: string, url: string): string {
  return (
    text +
    `\n\n---\nYou received this email because you're on our list.\nUnsubscribe: ${url}`
  );
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

  const deliveredTo: string[] = [];
  const deliveredCc: string[] = [];
  const suppressed: string[] = [];

  if (transactional === true) {
    deliveredTo.push(...to);
    if (cc && cc.length > 0) deliveredCc.push(...cc);
  } else {
    for (const addr of to) {
      if (await isSuppressed(db, addr)) {
        suppressed.push(addr);
      } else {
        deliveredTo.push(addr);
      }
    }
    if (cc) {
      for (const addr of cc) {
        if (await isSuppressed(db, addr)) {
          suppressed.push(addr);
        } else {
          deliveredCc.push(addr);
        }
      }
    }
  }

  // Nothing to send if every recipient was suppressed.
  if (deliveredTo.length === 0 && deliveredCc.length === 0) {
    return { delivered: [], suppressed };
  }

  let finalHeaders: Record<string, string> | undefined = headers
    ? { ...headers }
    : undefined;

  if (transactional !== true) {
    // Pick the primary recipient for token generation. Prefer the first `to`,
    // fall back to the first `cc` if `to` is empty after partitioning.
    const primary = deliveredTo[0] ?? deliveredCc[0];
    const token = await signToken(primary, env.UNSUBSCRIBE_SECRET);
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

  // The transport accepts a single `to` per call. Loop over delivered `to`
  // recipients; if there are none but there are `cc` recipients, send a single
  // call using the first `cc` as the primary address.
  let lastResult: SendEmailResult | undefined;
  const ccArg = deliveredCc.length > 0 ? deliveredCc : undefined;

  if (deliveredTo.length === 0) {
    // Edge case: only cc recipients survived. Use the first cc as `to` so the
    // transport has a recipient; remaining cc stays in the cc list.
    const [primary, ...rest] = deliveredCc;
    lastResult = await sender.send({
      from,
      to: primary,
      ...(rest.length > 0 ? { cc: rest } : {}),
      subject,
      html: html ?? "",
      ...(text !== undefined ? { text } : {}),
      ...(finalHeaders ? { headers: finalHeaders } : {}),
      ...(attachments ? { attachments } : {}),
    });
  } else {
    for (let i = 0; i < deliveredTo.length; i++) {
      const recipient = deliveredTo[i];
      // Only include cc on the first call to avoid duplicate cc deliveries
      // when `to` has multiple entries.
      const includeCc = i === 0 && ccArg !== undefined;
      lastResult = await sender.send({
        from,
        to: recipient,
        ...(includeCc ? { cc: ccArg } : {}),
        subject,
        html: html ?? "",
        ...(text !== undefined ? { text } : {}),
        ...(finalHeaders ? { headers: finalHeaders } : {}),
        ...(attachments ? { attachments } : {}),
      });
    }
  }

  return {
    delivered: [...deliveredTo, ...deliveredCc],
    suppressed,
    result: lastResult,
  };
}
