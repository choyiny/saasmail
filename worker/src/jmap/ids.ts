import type { SystemMailboxRole } from "./constants";

export type SystemMailboxId = {
  kind: "system";
  inbox: string;
  role: SystemMailboxRole;
};

export type CustomMailboxId = {
  kind: "custom";
  id: string;
};

export function systemMailboxId(
  inbox: string,
  role: SystemMailboxRole,
): string {
  return `sys:${inbox.toLowerCase()}:${role}`;
}

export function customMailboxId(id: string): string {
  return `mbx:${id}`;
}
