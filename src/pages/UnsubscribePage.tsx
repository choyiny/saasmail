import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { WordmarkSmall } from "@/components/Wordmark";
import { Button } from "@/components/ui/button";
import Footer from "@/components/Footer";

/**
 * `scope` mirrors the API: a v1 token suppresses the address everywhere, a v2
 * token removes one list membership. The wording has to follow, or someone who
 * left one newsletter is told they'll never hear from us again.
 */
type Scope = "global" | "list";

type State =
  | { kind: "loading" }
  | { kind: "suppressed"; email: string; scope: Scope }
  | { kind: "subscribed"; email: string; scope: Scope }
  | { kind: "undoExpired"; email: string }
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
        const body = (await r.json()) as { email: string; scope: Scope };
        if (cancelled) return;
        setState({
          kind: "suppressed",
          email: body.email,
          scope: body.scope ?? "global",
        });
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
      // 410 means the re-subscribe window has closed — a distinct outcome from
      // a failed request, and the only one where retrying can't help.
      if (r.status === 410) {
        setState((prev) =>
          prev.kind === "suppressed"
            ? { kind: "undoExpired", email: prev.email }
            : prev,
        );
        return;
      }
      if (!r.ok) return;
      const body = (await r.json()) as { email: string; scope: Scope };
      setState({
        kind: "subscribed",
        email: body.email,
        scope: body.scope ?? "global",
      });
    } catch {
      // Leave the page in `suppressed` so the user can retry.
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
                {state.scope === "list"
                  ? "has been removed from this mailing list."
                  : "won't receive any more emails from us."}
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
                {state.scope === "list"
                  ? "is back on this mailing list."
                  : "will continue to receive emails."}
              </p>
            </>
          )}

          {state.kind === "undoExpired" && (
            <>
              <h1 className="text-2xl font-extrabold tracking-tight text-text-primary">
                Re-subscribe window has closed
              </h1>
              <p className="mt-3 break-all text-sm text-text-secondary">
                <span className="font-medium text-text-primary">
                  {state.email}
                </span>{" "}
                unsubscribed too long ago for one-click undo. To get back on the
                list, ask the sender to add you again.
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
