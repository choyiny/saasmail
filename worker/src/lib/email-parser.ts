import PostalMime from "postal-mime";

export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dmarc: string | null;
}

export interface ParsedEmail {
  from: { address: string; name: string };
  to: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  messageId: string | null;
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
  auth: AuthResults;
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  contentId: string | null;
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

export async function parseEmail(
  message: ForwardableEmailMessage,
): Promise<ParsedEmail> {
  const rawEmail = await new Response(message.raw).arrayBuffer();
  const parser = new PostalMime();
  const parsed = await parser.parse(rawEmail);

  const headers: Record<string, string> = {};
  if (parsed.headers) {
    for (const header of parsed.headers) {
      headers[header.key] = header.value;
    }
  }

  const bodyText = parsed.text || null;
  const bodyHtml = parsed.html || null;

  return {
    from: {
      address: parsed.from?.address || message.from,
      name: parsed.from?.name || "",
    },
    to: message.to,
    subject: parsed.subject || "",
    bodyHtml: bodyHtml ? trimQuotedHtml(bodyHtml) : null,
    bodyText: bodyText ? trimQuotedText(bodyText) : null,
    messageId: parsed.messageId || null,
    headers,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || "unnamed",
      contentType: att.mimeType || "application/octet-stream",
      content: att.content,
      contentId: att.contentId || null,
    })),
    auth: parseAuthResults(headers),
  };
}
