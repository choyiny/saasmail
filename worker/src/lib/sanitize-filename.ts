/**
 * Strip path traversal sequences and dangerous characters from filenames.
 * Returns "unnamed" if the cleaned result would be empty.
 */
export function sanitizeFilename(filename: string): string {
  let cleaned = filename;
  let previous: string;

  do {
    previous = cleaned;
    cleaned = cleaned.replace(/\.\.[/\\]/g, ""); // strip path traversal
  } while (cleaned !== previous);

  return (
    cleaned
      .replace(/[/\\]/g, "_") // replace path separators
      .replace(/[\x00-\x1f]/g, "") // strip control characters
      .slice(0, 255) || // limit length
    "unnamed"
  );
}
