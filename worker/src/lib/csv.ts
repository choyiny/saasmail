/**
 * CSV helpers for list export.
 *
 * Two separate concerns are handled here and they are easy to confuse:
 *
 * 1. **RFC 4180 quoting** — making the file parse correctly.
 * 2. **Formula-injection escaping** — making the file safe to *open*. A cell
 *    beginning `=`, `+`, `-` or `@` is executed as a formula by Excel, Sheets
 *    and LibreOffice, so an attacker who can get a crafted string into a list
 *    (via the public subscribe form, say) could otherwise run code on the
 *    machine of whoever opens the export.
 *
 * Both must be applied, in that order: neutralize, then quote.
 */

/** Characters that make a spreadsheet treat a cell as a formula. */
const FORMULA_PREFIXES = ["=", "+", "-", "@"];

/**
 * Leading control characters that spreadsheets strip before evaluating, which
 * means `\t=cmd()` is still a live formula despite not starting with `=`.
 */
const STRIPPED_LEADERS = ["\t", "\r", "\n"];

/**
 * Neutralize a value that a spreadsheet would otherwise evaluate.
 *
 * Prefixes a single quote, which every major spreadsheet reads as "this is
 * text". The quote is visible in the cell's formula bar but not in the value,
 * and re-importing the CSV round-trips it as data.
 */
export function neutralizeFormula(value: string): string {
  if (value === "") return value;

  let probe = value;
  while (probe.length > 0 && STRIPPED_LEADERS.includes(probe[0])) {
    probe = probe.slice(1);
  }
  if (probe === "") return value;

  return FORMULA_PREFIXES.includes(probe[0]) ? `'${value}` : value;
}

/** Quote a single field per RFC 4180, after formula-neutralizing it. */
export function csvField(value: string | null | undefined): string {
  const safe = neutralizeFormula(value ?? "");
  // Quote when the value contains a delimiter, quote or newline. Quoting more
  // than strictly necessary is harmless; quoting less corrupts the file.
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/** Join one row's cells into a CRLF-terminated CSV line. */
export function csvRow(cells: Array<string | null | undefined>): string {
  return cells.map(csvField).join(",") + "\r\n";
}
