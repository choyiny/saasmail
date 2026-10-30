/**
 * Reads messages out of a window of an mbox file, without the rest of the
 * file: the importer reads a large file a few megabytes at a time.
 *
 * A message starts at a `From ` line at the start of the file or after an
 * empty line, whose rest has a time in it (`From sender Sat Oct  3 14:02:00
 * 2026`), so a body line "From here on…" after a blank line, in a file whose
 * writer did not quote it, does not split a message. mboxrd quoting is undone
 * (`>From ` loses one `>`, at any depth). CRLF and LF files both work.
 */

const NL = 0x0a;
const CR = 0x0d;
const GT = 0x3e;
const FROM_ = [0x46, 0x72, 0x6f, 0x6d, 0x20]; // "From "
const decoder = new TextDecoder("latin1");
const SEPARATOR = /^From \S+\s+.*\d{1,2}:\d{2}/;

export interface MboxMessage {
  /** Byte offset of the separator line in the file. */
  offset: number;
  /** Byte offset just past the message (where the next one starts). */
  end: number;
  /** The date on the separator line, when it reads as one. */
  separatorDate: Date | null;
  /** The message, its quoting undone and the blank line after it dropped. */
  bytes: Uint8Array;
}

export interface MboxWindow {
  /** The messages that end inside the window (or at the end of the file). */
  messages: MboxMessage[];
  /** Where the next read starts: the first message the window cut off. */
  nextOffset: number;
}

function startsWithFrom(bytes: Uint8Array, at: number): boolean {
  if (at + FROM_.length > bytes.length) return false;
  for (let i = 0; i < FROM_.length; i++) {
    if (bytes[at + i] !== FROM_[i]) return false;
  }
  return true;
}

/** Whether `at` follows an empty line (or is the window's start). */
function afterBlankLine(bytes: Uint8Array, at: number): boolean {
  if (at === 0) return true;
  if (bytes[at - 1] !== NL) return false;
  if (at >= 2 && bytes[at - 2] === NL) return true;
  return at >= 3 && bytes[at - 2] === CR && bytes[at - 3] === NL;
}

/** The end of the line starting at `at`: past its LF, or the window's end. */
function lineEnd(bytes: Uint8Array, at: number): number {
  const nl = bytes.indexOf(NL, at);
  return nl === -1 ? bytes.length : nl + 1;
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

/** The asctime date on a separator line (Gmail adds a zone before the year). */
export function separatorDate(line: string): Date | null {
  const match =
    /(?:\w{3}),?\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([+-]\d{4}))?\s+(\d{4})/.exec(
      line,
    );
  if (!match) return null;
  const [, mon, day, hour, minute, second, zone, year] = match;
  const month = MONTHS.indexOf(mon.toLowerCase());
  if (month === -1) return null;
  let ms = Date.UTC(
    Number(year),
    month,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second ?? 0),
  );
  if (zone) {
    const sign = zone[0] === "-" ? -1 : 1;
    ms -=
      sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3))) * 60_000;
  }
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** The message between a separator line and the next, unquoted. */
function messageBytes(
  bytes: Uint8Array,
  start: number,
  end: number,
): Uint8Array {
  // The blank line that ends an entry is the format's, not the message's.
  if (end - start >= 2 && bytes[end - 1] === NL) {
    if (bytes[end - 2] === NL) end -= 1;
    else if (
      end - start >= 4 &&
      bytes[end - 2] === CR &&
      bytes[end - 3] === NL
    ) {
      end -= 2;
    }
  }
  const body = bytes.subarray(start, end);
  // Undo mboxrd quoting: a line that is `>+From ` loses one `>`.
  const quoted: number[] = [];
  for (let at = 0; at < body.length; at = lineEnd(body, at)) {
    let probe = at;
    while (probe < body.length && body[probe] === GT) probe++;
    if (probe > at && startsWithFrom(body, probe)) quoted.push(at);
  }
  if (quoted.length === 0) return body;
  const out = new Uint8Array(body.length - quoted.length);
  let from = 0;
  let length = 0;
  for (const at of quoted) {
    out.set(body.subarray(from, at), length);
    length += at - from;
    from = at + 1; // skip one ">"
  }
  out.set(body.subarray(from), length);
  return out;
}

/**
 * The separator lines in the window: their start, the end of the line, and
 * its text. Only whole lines count: a candidate the window cuts off is
 * decided by the next window, which starts at the message before it.
 */
function separators(
  bytes: Uint8Array,
  final: boolean,
): { start: number; lineEnd: number; line: string }[] {
  const found: { start: number; lineEnd: number; line: string }[] = [];
  let at = 0;
  for (;;) {
    if (startsWithFrom(bytes, at) && afterBlankLine(bytes, at)) {
      const end = lineEnd(bytes, at);
      const whole = bytes[end - 1] === NL || final;
      const line = decoder.decode(bytes.subarray(at, Math.min(end, at + 512)));
      if (whole && SEPARATOR.test(line)) {
        found.push({ start: at, lineEnd: end, line });
      }
    }
    const nl = bytes.indexOf(NL, at);
    if (nl === -1) return found;
    at = nl + 1;
  }
}

/**
 * The complete messages in `window`, which holds the file's bytes from
 * `offset` on and starts at a separator. `final`: the window reaches the end
 * of the file, so its last message is complete too. When no message ends in
 * the window, `nextOffset` is `offset`: the caller reads a larger window.
 */
export function readMessages(
  window: Uint8Array,
  offset: number,
  final: boolean,
): MboxWindow {
  const found = separators(window, final);
  const messages: MboxMessage[] = [];
  for (let i = 0; i < found.length; i++) {
    const separator = found[i]!;
    const next = found[i + 1];
    if (!next && !final) {
      return { messages, nextOffset: offset + separator.start };
    }
    const end = next ? next.start : window.length;
    messages.push({
      offset: offset + separator.start,
      end: offset + end,
      separatorDate: separatorDate(separator.line),
      bytes: messageBytes(window, separator.lineEnd, end),
    });
  }
  return { messages, nextOffset: offset + window.length };
}

/**
 * Where the first message of an mbox file starts (after a byte order mark or
 * blank lines), or -1 when the file is not an mbox but one message.
 */
export function mboxStart(head: Uint8Array): number {
  let at = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) at = 3;
  while (at < head.length && (head[at] === NL || head[at] === CR)) at++;
  if (!startsWithFrom(head, at)) return -1;
  const line = decoder.decode(head.subarray(at, lineEnd(head, at)));
  return SEPARATOR.test(line) ? at : -1;
}
