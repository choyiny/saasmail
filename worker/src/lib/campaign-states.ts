import type { campaigns } from "../db/campaigns.schema";

export type CampaignStatus = (typeof campaigns.$inferSelect)["status"];

/**
 * Which actions are legal from which state.
 *
 * Written as one table rather than scattered `if (status !== ...)` checks so
 * the whole machine is visible in one place and testable exhaustively. Anything
 * not listed is invalid and answers 409 — a campaign is real mail to real
 * people, so "unspecified transition" must fail loudly rather than do something
 * plausible.
 */
export const ALLOWED_TRANSITIONS: Record<CampaignAction, CampaignStatus[]> = {
  /** Draft-only edits: content is frozen the moment a campaign leaves draft. */
  edit: ["draft"],
  delete: ["draft"],
  /** `overdue` is included: firing a stale campaign needs explicit confirmation. */
  send: ["draft", "scheduled", "overdue"],
  schedule: ["draft", "scheduled"],
  cancel: ["draft", "scheduled", "overdue", "preparing", "sending"],
  /**
   * Retry is for a campaign that stopped part-way. `completed_with_failures` is
   * included so an operator can re-attempt the recoverable failures; the
   * recipient-level claim is what prevents it touching `permanent_failed` or
   * `unknown` rows.
   */
  retry: ["stalled", "completed_with_failures"],
  /** Preview and test-send never create recipients, so they stay available. */
  preview: ["draft", "scheduled", "overdue"],
  test_send: ["draft", "scheduled", "overdue"],
};

export type CampaignAction =
  | "edit"
  | "delete"
  | "send"
  | "schedule"
  | "cancel"
  | "retry"
  | "preview"
  | "test_send";

export function canPerform(
  action: CampaignAction,
  status: CampaignStatus,
): boolean {
  return ALLOWED_TRANSITIONS[action].includes(status);
}
