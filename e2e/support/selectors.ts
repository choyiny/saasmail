// Centralized data-testid strings used by specs. Only add entries here when
// a role/label/text selector is genuinely ambiguous — prefer built-in
// selectors where possible. When adding an entry, also add the matching
// data-testid to the component.

export const TEST_IDS = {
  // Auth / navigation
  logoutButton: "logout-button",

  // Inbox admin page
  inboxRow: "inbox-row",
  inboxCreateButton: "inbox-create-button",
  inboxModeToggle: "inbox-mode-toggle",

  // Sequences
  sequenceRow: "sequence-row",
  sequenceStepRow: "sequence-step-row",

  // Display
  chatBubble: "chat-bubble",
  threadMessage: "thread-message",

  // Compose
  composeSendButton: "compose-send-button",
  composeBody: "compose-body",

  // API keys
  apiKeyRow: "api-key-row",
  apiKeyRevealed: "api-key-revealed",
} as const;
