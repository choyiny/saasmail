/**
 * Strip path traversal sequences and dangerous characters from filenames.
 * Returns "unnamed" if the cleaned result would be empty.
 */
export function sanitizeFilename(filename: string): string {
  return (
    filename
      .replace(/\.\.[/\\]/g, "") // strip path traversal
      .replace(/[/\\]/g, "_") // replace path separators
      .replace(/[\x00-\x1f]/g, "") // strip control characters
      .slice(0, 255) || // limit length
    "unnamed"
  );
}
