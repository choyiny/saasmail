import type { SystemMailboxRole } from "./constants";
import { publicCustomMailboxId, publicSystemMailboxId } from "./public-ids";

export type SystemMailboxId = {
  kind: "system";
  inbox: string;
  role: SystemMailboxRole;
};

export type CustomMailboxId = {
  kind: "custom";
  id: string;
};

/** Public JMAP id of a system mailbox (see public-ids.ts). */
export function systemMailboxId(
  inbox: string,
  role: SystemMailboxRole,
): string {
  return publicSystemMailboxId(inbox, role);
}

/** Public JMAP id of a custom folder (see public-ids.ts). */
export function customMailboxId(id: string): string {
  return publicCustomMailboxId(id);
}
