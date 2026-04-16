import { useState } from "react";
import { Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
import ComposeModal from "@/pages/ComposeModal";

export default function DashboardLayout() {
  const [composeOpen, setComposeOpen] = useState(false);

  return (
    <div className="flex h-screen bg-bg">
      <Sidebar onCompose={() => setComposeOpen(true)} />
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
      <ComposeModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        replyToEmailId={null}
      />
    </div>
  );
}
