export function mailAgentInstanceName(
  userId: string,
  sessionId: string,
): string {
  return `u-${userId}-s-${sessionId}`;
}

export function mailAgentSessionIdForUser(
  instanceName: string,
  userId: string,
): string | null {
  const prefix = `u-${userId}-s-`;
  if (!instanceName.startsWith(prefix)) {
    return null;
  }

  const sessionId = instanceName.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
}
