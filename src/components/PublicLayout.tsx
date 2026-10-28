import { Outlet } from "react-router-dom";
import Footer from "@/components/Footer";

/**
 * Wraps every public route (login, onboarding, invite, setup-passkey,
 * consent): the portal's navy chrome with grain, the page's card centred,
 * and the footer underneath.
 */
export default function PublicLayout() {
  return (
    <div className="pt-auth">
      <main className="flex flex-1 items-center justify-center px-4 py-12 sm:py-16">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}
