import { useLayoutSettings } from "@/lib/preferences";
import { DEFAULT_UNDO_SEND_SECONDS } from "@/lib/undo-send";

const COMMON_DEFAULTS = { undoSendSeconds: DEFAULT_UNDO_SEND_SECONDS };

/** The account-wide Undo Send delay (shared by every layout). */
export function useUndoSendSetting() {
  return useLayoutSettings("common", COMMON_DEFAULTS);
}
