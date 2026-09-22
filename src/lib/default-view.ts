export const DEFAULT_VIEW_STORAGE_KEY = "saasmail.defaultView";

export type DefaultView = "customers" | "mailbox";

export function readDefaultView(): DefaultView {
  if (typeof window === "undefined") return "customers";
  return window.localStorage.getItem(DEFAULT_VIEW_STORAGE_KEY) === "mailbox"
    ? "mailbox"
    : "customers";
}

export function writeDefaultView(value: DefaultView): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(DEFAULT_VIEW_STORAGE_KEY, value);
}
