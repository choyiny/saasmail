import { lazy, Suspense } from "react";
import InboxPage from "@/pages/InboxPage";
import { useUiTheme } from "@/lib/preferences";

// The Gmail and Outlook layouts are split out so the default bundle does
// not carry them.
const GmailInbox = lazy(() => import("@/themes/gmail/GmailInbox"));
const OutlookInbox = lazy(() => import("@/themes/outlook/OutlookInbox"));

/** The inbox for the user's chosen mail theme. */
export function ThemedInbox() {
  const ui = useUiTheme();
  if (ui === "default") return <InboxPage />;
  return (
    <Suspense fallback={null}>
      {ui === "gmail" ? <GmailInbox /> : <OutlookInbox />}
    </Suspense>
  );
}
