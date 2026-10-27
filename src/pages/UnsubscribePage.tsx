import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { WordmarkSmall } from "@/components/Wordmark";
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
    <div className="pt-auth">
      {/* Brand strip — mirrors LegalLayout. */}
      <header className="mx-auto flex w-full max-w-[1000px] items-center px-4 py-4 md:px-6">
        <Link to="/" className="transition-opacity hover:opacity-85">
          <WordmarkSmall />
        </Link>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 pb-16 pt-6">
        <div className="pt-auth-card !max-w-[460px] text-center">
          {state.kind === "loading" && (
            <>
              <h1 className="text-[18px] font-semibold leading-tight tracking-[-0.015em] text-text-primary">
                Processing your request…
              </h1>
              <p className="mt-2 text-[14px] leading-relaxed text-text-secondary">
                One moment while we update your preferences.
              </p>
            </>
          )}

          {state.kind === "suppressed" && (
            <>
              <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
                You've been unsubscribed
              </h1>
              <p className="mt-3 break-all text-[14px] leading-relaxed text-text-secondary">
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
              <h1 className="text-[20px] font-semibold leading-tight tracking-[-0.02em] text-text-primary">
                You're subscribed again
              </h1>
              <p className="mt-3 break-all text-[14px] leading-relaxed text-text-secondary">
                <span className="font-medium text-text-primary">
                  {state.email}
                </span>{" "}
                will continue to receive emails.
              </p>
            </>
          )}

          {state.kind === "error" && (
            <>
              <h1 className="text-[18px] font-semibold leading-tight tracking-[-0.015em] text-text-primary">
                This unsubscribe link is invalid or expired
              </h1>
              <p className="mt-3 text-[14px] leading-relaxed text-text-secondary">
                If you keep receiving unwanted emails, reply to one of them and
                let the sender know directly.
              </p>
            </>
          )}
        </div>
      </main>

      <Footer />
    </div>
  );
}
