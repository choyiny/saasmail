// RFC 8620 §1.4 Date and UTCDate: RFC 3339 date-time, UTCDate with "Z".
// `Date.parse` alone is not a validator: it accepts other formats and rolls
// impossible calendar dates over ("2026-02-30" becomes March 2), so a client
// could store a date nobody wrote.

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/i;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * Milliseconds since the epoch for a valid RFC 3339 date-time, or null. With
 * `utc`, only the `Z` form (a UTCDate) is accepted.
 */
export function parseJmapDate(
  value: unknown,
  opts: { utc?: boolean } = {},
): number | null {
  if (typeof value !== "string") return null;
  const match = DATE_TIME.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, zone, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  if (opts.utc && zone.toUpperCase() !== "Z") return null;
  if (month < 1 || month > 12) return null;
  if (Number(d) < 1 || Number(d) > daysInMonth(year, month)) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  if (oh !== undefined && (Number(oh) > 23 || Number(om) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
