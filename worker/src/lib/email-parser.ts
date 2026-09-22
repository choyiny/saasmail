import PostalMime, { type Address, type Mailbox } from "postal-mime";

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
   * The recipient headers as WRITTEN — unparsed, unfiltered, undecoded.
   *
   * Each is the value of the FIRST header of that name in the message, with
   * folding unwrapped and nothing else done to it. `null` means the message
   * carried no header of that name at all; an empty string means it carried
   * an empty one, and the two are not the same thing to a caller that must
   * decide whether to look at the next header.
   *
   * Deliberately raw, and deliberately not `ParsedEmailAddress[]`. A caller
   * that needs the FIRST-WRITTEN recipient cannot get it from a parsed list:
   * any list that has been filtered has silently renumbered itself, so its
   * element 0 is the first SURVIVING recipient, which is a different person
   * from the first written one exactly when the first written one is
   * malformed. Only the original text can answer "was anything ahead of
   * this?", so the original text is what is handed over.
   *
   * "First header of that name" matters too: postal-mime's own `to`/`cc`
   * arrays concatenate duplicate headers LAST-header-first, which reverses
   * the written order of a message carrying two `To:` lines.
   *
   * NOT a substitute for `to`, which is the SMTP envelope recipient and the
   * only thing that decides where inbound mail lands. These are what the
   * sender typed, which may be a mailing list, an alias, a group, a dozen
   * people, or nobody at all.
   *
   * Exists for the Gmail Sent-folder mirror, which has no envelope to go on:
   * a message the mailbox sent has its counterparty on these lines. `bcc` is
   * there because received mail normally has it stripped in transit, but a
   * message in the SENDER's own Sent folder usually keeps the Bcc it went out
   * with, and that is the only counterparty a blind-copied send has.
   */
  recipientHeaders: {
    to: string | null;
    cc: string | null;
    bcc: string | null;
  };
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

  // postal-mime types an address list as `Address[]`, a union of a plain
  // mailbox and an RFC 5322 GROUP (`Team: a@x.com, b@y.com;`), which arrives
  // as `{ name, group: Mailbox[] }` with no `.address` at all. A group's
  // members are ordinary recipients that happen to be written inside a label,
  // so they are spliced into the list where the group stood rather than
  // vanishing with it. An empty group (`undisclosed-recipients:;`) therefore
  // contributes nothing, which is correct — it names nobody.
  const flatten = (list: Address[] | undefined): Mailbox[] => {
    const out: Mailbox[] = [];
    for (const entry of list ?? []) {
      if (entry.address !== undefined) out.push(entry);
      else out.push(...entry.group);
    }
    return out;
  };

  // Normalize one of postal-mime's parsed address lists into the roster shape
  // the rest of the app stores and displays. We
  // - filter to entries with a syntactically-valid email (don't trust
  //   header data — malformed Cc: lines pollute displayed rosters
  //   and the de-dupe-by-email logic elsewhere),
  // - lowercase the address so casing variants of the same recipient
  //   don't fork conversation_id buckets,
  // - cap the array so a single inbound message can't slam storage
  //   with thousands of header-entries.
  //
  // Relative order survives, but ENTRIES DO NOT: a recipient this filter
  // dislikes is deleted and everyone behind them moves up one. So this list
  // answers "who else was on the message", and it cannot answer "who was
  // written first" — element 0 is the first recipient that SURVIVED. Callers
  // that need the first-written recipient must read `recipientHeaders`.
  const addressList = (list: Address[] | undefined): ParsedEmailAddress[] =>
    flatten(list)
      .filter((c) => {
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

  // The FIRST header of each name, in the order the message wrote them.
  // `parsed.headers` preserves duplicates and document order; the `headers`
  // map built above does not (a second `To:` overwrites the first), and
  // postal-mime's own `parsed.to` concatenates duplicates last-header-first.
  const firstHeaderValue = (key: string): string | null =>
    parsed.headers?.find((h) => h.key === key)?.value ?? null;

  return {
    from: {
      address: parsed.from?.address || envelope.from,
      name: parsed.from?.name || "",
    },
    to: envelope.to,
    cc,
    recipientHeaders: {
      to: firstHeaderValue("to"),
      cc: firstHeaderValue("cc"),
      bcc: firstHeaderValue("bcc"),
    },
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
