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
  inboxCreateEmail: "inbox-create-email",
  inboxCreateDisplayName: "inbox-create-display-name",
  inboxDisplayNameInput: "inbox-display-name-input",
  inboxModeToggle: "inbox-mode-toggle",
  inboxDeleteButton: "inbox-delete-button",
  inboxMemberToggle: "inbox-member-toggle",

  // Sequences
  sequenceRow: "sequence-row",
  sequenceStepRow: "sequence-step-row",
  enrollmentRow: "enrollment-row",

  // Templates
  templateRow: "template-row",

  // Display
  chatBubble: "chat-bubble",
  threadMessage: "thread-message",

  // Person list
  personRow: "person-row",
  personUnreadBadge: "person-unread-badge",
  personKebabMenu: "person-kebab-menu",
  personDeleteButton: "person-delete-button",
  personSearchInput: "person-search-input",
  personSearchClear: "person-search-clear",

  // Compose
  composeSendButton: "compose-send-button",
  composeBody: "compose-body",

  // Reply
  replySendButton: "reply-send-button",
  replyComposer: "reply-composer",

  // API keys
  apiKeyRow: "api-key-row",
  apiKeyRevealed: "api-key-revealed",
} as const;
