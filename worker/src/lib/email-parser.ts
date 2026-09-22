import PostalMime from "postal-mime";

export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface ParsedEmailAddress {
  email: string;
  name: string | null;
}

export interface ParsedEmail {
  from: { address: string; name: string };
  to: string;
  /** Additional recipients on the Cc: line, parsed from the MIME headers. */
  cc: ParsedEmailAddress[];
  /**
   * The `To:` header's address list, as parsed from the MIME headers.
   *
   * NOT the same thing as `to`, and never a substitute for it: `to` is the
   * SMTP envelope recipient — the inbox this message was actually delivered
   * to — and that is what decides where inbound mail lands. This is what the
   * sender WROTE on the To: line, which may be a mailing list, an alias, a
   * dozen people, or nobody at all.
   *
   * Exists for the Gmail Sent-folder mirror, which has no envelope to go on:
   * a message the mailbox sent has its counterparty on this line.
   */
  headerTo: ParsedEmailAddress[];
  /**
   * The `Bcc:` header's address list, when the message still carries one.
   *
   * Received mail normally does not — the header is stripped in transit — but
   * a message in the SENDER's own Sent folder usually keeps the Bcc it went
   * out with, which is the only counterparty a blind-copied send has.
   */
  headerBcc: ParsedEmailAddress[];
  subject: string;
  /** Quote-trimmed HTML body, with `cid:` refs left intact. For display/storage. */
  bodyHtml: string | null;
  /** Quote-trimmed plain-text body. For display/storage. */
  bodyText: string | null;
  /**
   * Untrimmed HTML body, exactly as received. Used when relaying the message
   * onward (per-inbox forwarding), where dropping the quoted reply history
   * would lose context the recipient needs.
   */
  fullBodyHtml: string | null;
  /** Untrimmed plain-text body, exactly as received. See `fullBodyHtml`. */
  fullBodyText: string | null;
  messageId: string | null;
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
  auth: AuthResults;
  spamScore: number | null;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  contentId: string | null;
  disposition: string | null;
}

/**
 * Trim quoted reply content from plain text email bodies.
 * Removes lines starting with ">" and common quote headers like
 * "On Mon, Jan 1, 2024 at 10:00 AM ... wrote:" that email clients
 * append when replying.
 */
export function trimQuotedText(text: string): string {
  const lines = text.split("\n");
  let cutIndex = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Line starts with ">" — quoted content
    if (line.startsWith(">")) {
      // Check if previous non-empty line is a quote header like "On ... wrote:"
      if (i > 0 && /^On .+ wrote:$/i.test(lines[i - 1].trim())) {
        cutIndex = i - 1;
      } else {
        cutIndex = i;
      }
      break;
    }

    // Gmail/Apple-style separator
    if (
      /^On .+ wrote:$/i.test(line) ||
      /^-{2,}\s*Original Message\s*-{2,}$/i.test(line) ||
      /^-{2,}\s*Forwarded message\s*-{2,}$/i.test(line) ||
      line === "________________________________________"
    ) {
      cutIndex = i;
      break;
    }
  }

  return lines.slice(0, cutIndex).join("\n").trimEnd();
}

/**
 * Trim quoted reply content from HTML email bodies.
 * Removes common wrapper elements that email clients use:
 * - Gmail: <div class="gmail_quote">
 * - Apple Mail / Outlook: <blockquote>
 * - Generic: elements with class containing "quote" or "moz-cite-prefix"
 */
export function trimQuotedHtml(html: string): string {
  // Gmail quote block
  let trimmed = html.replace(/<div\s+class="gmail_quote"[\s\S]*$/i, "");

  // Yahoo quote header + blockquote
  trimmed = trimmed.replace(/<div\s+id="yahoo_quoted_[\s\S]*$/i, "");

  // Outlook-style "Original Message" separator and everything after
  trimmed = trimmed.replace(
    /<div\s[^>]*style="border:none;border-top:solid #[A-Fa-f0-9]+ 1\.0pt[\s\S]*$/i,
    "",
  );

  // Generic blockquote at the end (Apple Mail, Thunderbird)
  trimmed = trimmed.replace(/<div\s+class="moz-cite-prefix"[\s\S]*$/i, "");

  return trimmed.trimEnd();
}

/**
 * Parse Authentication-Results header for SPF, DKIM, and DMARC verdicts.
 * Returns the verdict string (e.g. "pass", "fail", "none") or null if absent.
 */
function parseAuthResults(headers: Record<string, string>): AuthResults {
  const raw =
    headers["authentication-results"] ||
    headers["Authentication-Results"] ||
    "";
  if (!raw) return { spf: null, dkim: null, dmarc: null };

  const extract = (key: string): string | null => {
    const match = raw.match(new RegExp(`${key}=([a-zA-Z]+)`));
    return match ? match[1].toLowerCase() : null;
  };

  return {
    spf: extract("spf"),
    dkim: extract("dkim"),
    dmarc: extract("dmarc"),
  };
}

function parseSpamScore(headers: Record<string, string>): number | null {
  const raw = headers["x-spam-score"] ?? headers["X-Spam-Score"];
  if (!raw) return null;
  const n = Number.parseFloat(raw.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse raw RFC822 bytes. The envelope carries the SMTP-level sender and
 * recipient, which are not always present or trustworthy in the MIME
 * headers — `from` is a fallback when the message has no parseable From,
 * and `to` is the inbox this message was delivered to.
 *
 * Split out from `parseEmail` so a non-Cloudflare source can reuse it:
 * the Gmail API's `messages.get(format=raw)` returns the same bytes the
 * Email Worker receives.
 *
 * A Gmail caller often cannot know the correct inbox before parsing — the
 * real address may live in a `Delivered-To` or `List-ID` header inside
 * `raw` rather than the envelope — so such a caller may pass a provisional
 * `envelope.to` and reassign `parsed.to` afterwards.
 */
export async function parseRaw(
  raw: ArrayBuffer,
  envelope: { from: string; to: string },
): Promise<ParsedEmail> {
  const parser = new PostalMime();
  const parsed = await parser.parse(raw);

  const headers: Record<string, string> = {};
  if (parsed.headers) {
    for (const header of parsed.headers) {
      headers[header.key] = header.value;
    }
  }

  const bodyText = parsed.text || null;
  const bodyHtml = parsed.html || null;

  // Normalize one of postal-mime's parsed address lists — it exposes each as
  // an array of `{ address, name }`, or undefined when the header is absent.
  // We
  // - filter to entries with a syntactically-valid email (don't trust
  //   header data — malformed Cc: lines pollute displayed rosters
  //   and the de-dupe-by-email logic elsewhere),
  // - lowercase the address so casing variants of the same recipient
  //   don't fork conversation_id buckets,
  // - cap the array so a single inbound message can't slam storage
  //   with thousands of header-entries.
  //
  // Order is preserved, which matters to callers that need the FIRST-written
  // recipient rather than any recipient.
  const addressList = (raw: unknown): ParsedEmailAddress[] =>
    ((raw as Array<{ address?: string; name?: string }> | undefined) ?? [])
      .filter((c): c is { address: string; name?: string } => {
        if (!c.address || typeof c.address !== "string") return false;
        // Cheap RFC 5322-ish gate. Defers strict validation to downstream
        // schemas; we only need to reject the obviously-not-email cases.
        return /^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(c.address.trim());
      })
      .slice(0, 50)
      .map((c) => ({
        email: c.address.trim().toLowerCase(),
        name: c.name && c.name.trim() ? c.name.trim().slice(0, 200) : null,
      }));

  const cc: ParsedEmailAddress[] = addressList(parsed.cc);

  return {
    from: {
      address: parsed.from?.address || envelope.from,
      name: parsed.from?.name || "",
    },
    to: envelope.to,
    cc,
    headerTo: addressList(parsed.to),
    headerBcc: addressList((parsed as { bcc?: unknown }).bcc),
    subject: parsed.subject || "",
    bodyHtml: bodyHtml ? trimQuotedHtml(bodyHtml) : null,
    bodyText: bodyText ? trimQuotedText(bodyText) : null,
    fullBodyHtml: bodyHtml,
    fullBodyText: bodyText,
    messageId: parsed.messageId || null,
    headers,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || "unnamed",
      contentType: att.mimeType || "application/octet-stream",
      content: att.content,
      contentId: att.contentId || null,
      disposition: att.disposition || null,
    })),
    auth: parseAuthResults(headers),
    spamScore: parseSpamScore(headers),
  };
}

/** Adapter for the Cloudflare Email Worker entry point. */
export async function parseEmail(
  message: ForwardableEmailMessage,
): Promise<ParsedEmail> {
  const raw = await new Response(message.raw).arrayBuffer();
  return parseRaw(raw, { from: message.from, to: message.to });
}
