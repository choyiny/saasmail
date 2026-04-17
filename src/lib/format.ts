/**
 * Returns a formatted label for the From dropdown.
 * Shows "Display Name <email>" if a display name is configured, otherwise just the email.
 */
export function getFromLabel(
  email: string,
  senderIdentities: Array<{ email: string; displayName: string | null }>,
): string {
  const identity = senderIdentities.find((s) => s.email === email);
  return identity?.displayName ? `${identity.displayName} <${email}>` : email;
}
