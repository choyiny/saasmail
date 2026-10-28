import { Navigate } from "react-router-dom";
import { ThemedInbox } from "@/themes";
import { readDefaultView } from "@/lib/default-view";

export default function DefaultHomeRoute() {
  if (readDefaultView() === "mailbox") {
    return <Navigate to="/mail" replace />;
  }
  return <ThemedInbox />;
}
