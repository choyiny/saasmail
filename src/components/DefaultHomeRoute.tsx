import { Navigate } from "react-router-dom";
import InboxPage from "@/pages/InboxPage";
import { readDefaultView } from "@/lib/default-view";

export default function DefaultHomeRoute() {
  if (readDefaultView() === "mailbox") {
    return <Navigate to="/mail" replace />;
  }
  return <InboxPage />;
}
