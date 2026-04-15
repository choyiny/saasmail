import PostalMime from "postal-mime";

export interface ParsedEmail {
  from: { address: string; name: string };
  to: string;
  subject: string;
  bodyHtml: string | null;
  bodyText: string | null;
  messageId: string | null;
  headers: Record<string, string>;
  attachments: ParsedAttachment[];
}

export interface ParsedAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
}

export async function parseEmail(
  message: ForwardableEmailMessage
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

  return {
    from: {
      address: message.from,
      name: parsed.from?.name || "",
    },
    to: message.to,
    subject: parsed.subject || "",
    bodyHtml: parsed.html || null,
    bodyText: parsed.text || null,
    messageId: parsed.messageId || null,
    headers,
    attachments: (parsed.attachments || []).map((att) => ({
      filename: att.filename || "unnamed",
      contentType: att.mimeType || "application/octet-stream",
      content: att.content,
    })),
  };
}
