import { MailUiProvider } from "./actions";
import { useIsMobile } from "./context";
import DesktopMail from "./DesktopMail";
import MobileMail from "./MobileMail";
import { useOutlookMail } from "./useOutlookMail";

/**
 * Outlook mail module. Desktop: ribbon, folder pane, message list and
 * reading pane. Phones: the Outlook mobile app (Focused/Other, swipe
 * actions, full-screen conversation and compose).
 */
export default function OutlookInbox() {
  const mail = useOutlookMail();
  const isMobile = useIsMobile();
  return (
    <MailUiProvider mail={mail}>
      {isMobile ? <MobileMail mail={mail} /> : <DesktopMail mail={mail} />}
    </MailUiProvider>
  );
}
