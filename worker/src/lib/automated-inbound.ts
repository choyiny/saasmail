function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

export function isAutomatedInbound(headers: Record<string, string>): boolean {
  const autoSubmitted = headerValue(headers, "auto-submitted");
  if (
    autoSubmitted !== undefined &&
    autoSubmitted.trim().toLowerCase() !== "no"
  ) {
    return true;
  }

  const precedence = headerValue(headers, "precedence")?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list" || precedence === "junk") {
    return true;
  }

  return (
    headerValue(headers, "list-id") !== undefined ||
    headerValue(headers, "list-unsubscribe") !== undefined
  );
}
