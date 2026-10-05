import { describe, expect, it, vi } from "vitest";
import {
  dispatchMailRefresh,
  MAIL_REFRESH_EVENT,
  onMailRefresh,
} from "../mail-events";

describe("mail refresh events", () => {
  it("dispatches and unsubscribes the mailbox refresh signal", () => {
    const handler = vi.fn();
    const unsubscribe = onMailRefresh(handler);

    dispatchMailRefresh();
    expect(handler).toHaveBeenCalledTimes(1);

    unsubscribe();
    window.dispatchEvent(new CustomEvent(MAIL_REFRESH_EVENT));
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
