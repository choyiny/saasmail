import type { GroupedItem, MailItemRef } from "@/lib/api";

/**
 * Small helpers for grouped inbox rows (people and group conversations),
 * shared by the default, Gmail and Outlook layouts.
 */

export function itemRef(item: GroupedItem): MailItemRef {
  return { type: item.type, id: item.id };
}

export function itemKey(item: Pick<GroupedItem, "type" | "id">): string {
  return `${item.type}:${item.id}`;
}

/** Display name for a row: the person, or the group's participants. */
export function itemTitle(item: GroupedItem): string {
  if (item.type === "person") return item.name || item.email;
  const names = item.participants.map((p) => p.name?.split(" ")[0] || p.email);
  return names.length > 0 ? names.join(", ") : item.inbox;
}

/** Common snooze presets (unix seconds), Gmail/Outlook style. */
export function snoozePresets(now = new Date()): Array<{
  id: string;
  label: string;
  until: number;
}> {
  const at = (d: Date, h: number) => {
    const x = new Date(d);
    x.setHours(h, 0, 0, 0);
    return x;
  };
  const addDays = (d: Date, n: number) => {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
  };
  const laterToday = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  laterToday.setMinutes(0, 0, 0);
  const tomorrow = at(addDays(now, 1), 8);
  const daysToSat = (6 - now.getDay() + 7) % 7 || 7;
  const weekend = at(addDays(now, daysToSat), 8);
  const daysToMon = (8 - now.getDay()) % 7 || 7;
  const nextWeek = at(addDays(now, daysToMon), 8);
  const sec = (d: Date) => Math.floor(d.getTime() / 1000);
  const presets = [
    { id: "later", label: "Later today", until: sec(laterToday) },
    { id: "tomorrow", label: "Tomorrow", until: sec(tomorrow) },
    { id: "weekend", label: "This weekend", until: sec(weekend) },
    { id: "next-week", label: "Next week", until: sec(nextWeek) },
  ];
  // "Later today" makes no sense late at night.
  return laterToday.getDate() === now.getDate()
    ? presets
    : presets.filter((p) => p.id !== "later");
}
