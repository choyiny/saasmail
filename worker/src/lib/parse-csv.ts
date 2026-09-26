/**
 * A small RFC 4180 CSV reader.
 *
 * Written by hand rather than pulled in as a dependency: the spec forbids new
 * dependencies without asking, and the subset needed here (quoted fields,
 * doubled quotes, embedded newlines, CRLF or LF, optional BOM) is small enough
 * to implement correctly and test exhaustively.
 *
 * The embedded-newline case is the one that matters: a quoted field may contain
 * a line break, so a CSV cannot be split on newlines. That is also why the
 * import stages parsed rows up front instead of resuming from a byte offset —
 * a byte offset alone cannot tell you whether you are inside a quoted field.
 */

/** Split CSV text into rows of raw cell strings. */
export function parseCsv(input: string): string[][] {
  // Strip a UTF-8 BOM: Excel writes one, and left in place it becomes part of
  // the first header name ("﻿email"), which then never matches "email".
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          // Doubled quote inside a quoted field is a literal quote.
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }

    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      // Consume CRLF as one terminator.
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += ch;
    i++;
  }

  // Trailing field/row, unless the file simply ended with a newline.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

export type CsvHeaderIndex = { email: number; name: number | null };

/**
 * Locate the required `email` column and the optional `name` one.
 *
 * Header names are matched case-insensitively and trimmed, because these files
 * come from spreadsheets and "Email " is the common shape.
 */
export function readCsvHeader(header: string[]): CsvHeaderIndex | null {
  const normalized = header.map((h) => h.trim().toLowerCase());
  const email = normalized.indexOf("email");
  if (email === -1) return null;
  const name = normalized.indexOf("name");
  return { email, name: name === -1 ? null : name };
}
