import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import Footer from "@/components/Footer";

type State =
  | { kind: "loading" }
  | { kind: "suppressed"; email: string }
  | { kind: "subscribed"; email: string }
  | { kind: "error" };

/**
 * Public, unauthenticated unsubscribe landing page.
 *
 * Mounted at `/unsubscribe?token=…`. On mount, POSTs to the public
 * `/api/unsubscribe` endpoint (see worker/src/routers/unsubscribe-router.ts).
 *
 * Bot-preview-defense pattern: the initial GET serves inert HTML — the
 * actual suppression write only happens once JS mounts and fires the POST.
 * Slack/iMessage/AV link scanners don't execute JS, so they hit the inert
 * landing without recording a suppression.
 */
export default function UnsubscribePage() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const [state, setState] = useState<State>({ kind: "loading" });
  const [undoLoading, setUndoLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setState({ kind: "error" });
      return;
    }
    let cancelled = false;
    const url = `/api/unsubscribe?token=${encodeURIComponent(token)}&source=user-link`;
    fetch(url, { method: "POST" })
      .then(async (r) => {
        if (!r.ok) throw new Error("invalid");
        const body = (await r.json()) as { email: string; status: string };
        if (cancelled) return;
        setState({ kind: "suppressed", email: body.email });
      })
      .catch(() => {
        if (cancelled) return;
        setState({ kind: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function handleResubscribe() {
    if (!token) return;
    setUndoLoading(true);
    try {
      const url = `/api/unsubscribe/undo?token=${encodeURIComponent(token)}`;
      const r = await fetch(url, { method: "POST" });
      if (!r.ok) return;
      const body = (await r.json()) as { email: string; status: string };
      setState({ kind: "subscribed", email: body.email });
    } catch {
      // v1: leave the page in `suppressed` so the user can retry.
    } finally {
      setUndoLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-background">
      <div className="dashboard-backdrop" aria-hidden />
      <div className="dashboard-backdrop-mask" aria-hidden />

      {/* Brand strip — mirrors LegalLayout so the page sits next to /terms
          and /privacy stylistically. */}
      <header className="relative z-10">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-6 md:px-6">
          <Link
            to="/"
            className="flex items-center gap-2 text-text-primary transition-opacity hover:opacity-80"
          >
            <Mail
              className="h-5 w-5"
              strokeWidth={2.5}
              style={{ color: "#7c5cfc" }}
              aria-hidden
            />
            <span className="text-lg font-extrabold uppercase tracking-tight">
              saasmail
            </span>
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16">
        <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 text-center shadow-sm">
          {state.kind === "loading" && (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-text-primary">
                Processing your request…
              </h1>
              <p className="mt-2 text-sm text-text-secondary">
                One moment while we update your preferences.
              </p>
            </>
          )}

          {state.kind === "suppressed" && (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight text-text-primary">
                You've been unsubscribed
              </h1>
              <p className="mt-3 break-all text-sm text-text-secondary">
                <span className="font-medium text-text-primary">
                  {state.email}
                </span>{" "}
                won't receive any more emails from us.
              </p>
              <div className="mt-6">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleResubscribe}
                  disabled={undoLoading}
                >
                  {undoLoading ? "Updating…" : "Re-subscribe"}
                </Button>
              </div>
              <p className="mt-4 text-xs text-text-tertiary">
                Changed your mind? Re-subscribing only restores delivery — it
                doesn't sign you up for anything new.
              </p>
            </>
          )}

          {state.kind === "subscribed" && (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight text-text-primary">
                You're subscribed again
              </h1>
              <p className="mt-3 break-all text-sm text-text-secondary">
                <span className="font-medium text-text-primary">
                  {state.email}
                </span>{" "}
                will continue to receive emails.
              </p>
            </>
          )}

          {state.kind === "error" && (
            <>
              <h1 className="text-xl font-semibold tracking-tight text-text-primary">
                This unsubscribe link is invalid or expired
              </h1>
              <p className="mt-3 text-sm text-text-secondary">
                If you keep receiving unwanted emails, reply to one of them and
                let the sender know directly.
              </p>
            </>
          )}
        </div>
      </main>

      <div className="relative z-10">
        <Footer variant="light" />
      </div>
    </div>
  );
}
