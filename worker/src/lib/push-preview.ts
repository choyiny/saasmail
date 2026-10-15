/**
 * Text for a new-mail push notification: the subject on the first line and
 * the opening of the message under it, the way a phone's mail app shows it.
 *
 * The OS decides how much of the body fits (about two lines on macOS, more
 * on an expanded Android notification) and clips the rest itself, so this
 * only has to send a sensible amount: enough to fill the space, small enough
 * to stay well under the ~4 KB a push payload can carry.
 */

/** Characters of message text to send. More than any platform shows. */
export const PUSH_PREVIEW_CHARS = 200;

/**
 * The opening of a message as a single line of plain text.
 *
 * `bodyText` arrives with quoted replies already trimmed by the parser. A
 * message sent as HTML only has no text part, so the HTML is flattened
 * instead — otherwise those notifications would show the subject alone.
 */
export function messagePreview(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
  max = PUSH_PREVIEW_CHARS,
): string {
  const source = bodyText?.trim() ? bodyText : htmlToText(bodyHtml ?? "");
  // Line breaks would spend the few lines a notification has on blank space.
  const flat = source.replace(/\s+/g, " ").trim();
  return truncate(flat, max);
}

/** The notification body: subject, then the preview on the next line. */
export function pushBody(subject: string, preview: string): string {
  return [subject.trim(), preview.trim()].filter(Boolean).join("\n");
}

function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " "),
  );
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X"
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}

/** Cut at a word boundary, by code point so an emoji is never split. */
function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) return s;
  const cut = chars.slice(0, max).join("");
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + "…";
}
