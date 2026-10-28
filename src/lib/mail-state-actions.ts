/**
 * Star, pin, archive, snooze and trash in the grouped inbox (the shells'
 * Starred, Snoozed, Archive and Trash views and their controls) arrive in a
 * later release; until then this stays false and the grouped inbox shows
 * only Inbox and Sent. The /mail page keeps its own state controls.
 * See docs/mailbox-state.md.
 */
export const MAIL_STATE_ACTIONS_ENABLED: boolean = false;
