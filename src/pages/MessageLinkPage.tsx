import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { fetchEmail } from "@/lib/api";

/**
 * Resolves a shareable `/m/<emailId>` link to the in-app location of the
 * message. Looks up the email's person + owning inbox, then redirects to
 * the existing person route with a `#m=<emailId>` hash for PersonDetail
 * to scroll/flash. `replace` keeps the resolver URL out of history so the
 * back button doesn't bounce.
 */
export default function MessageLinkPage() {
  const { emailId } = useParams<{ emailId: string }>();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!emailId) {
      setError("Missing message id");
      return;
    }
    let cancelled = false;
    fetchEmail(emailId)
      .then((email) => {
        if (cancelled) return;
        // For received emails the owning inbox is `recipient`; for sent
        // emails the API returns recipient: null and the inbox is the
        // outbound identity in `fromAddress`. Mirror inboxOf() in PersonDetail.
        const inbox =
          email.type === "received" ? email.recipient : email.fromAddress;
        const personId = email.personId;
        if (!personId || !inbox) {
          setError("This message can't be opened in the inbox view.");
          return;
        }
        navigate(
          `/inbox/${encodeURIComponent(inbox)}/${encodeURIComponent(personId)}#m=${encodeURIComponent(emailId)}`,
          { replace: true },
        );
      })
      .catch(() => {
        if (cancelled) return;
        setError("Message not found, or you don't have access to it.");
      });
    return () => {
      cancelled = true;
    };
  }, [emailId, navigate]);

  if (error) {
    return (
      <div className="flex h-full flex-1 items-center justify-center px-6 py-16">
        <div className="max-w-sm rounded-2xl bg-card p-8 text-center ring-1 ring-border">
          <h2 className="text-base font-semibold text-text-primary">
            Can't open this message
          </h2>
          <p className="mt-2 text-sm text-text-secondary">{error}</p>
          <Link
            to="/"
            className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
          >
            Back to inbox
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-1 items-center justify-center text-sm text-text-tertiary">
      Opening message…
    </div>
  );
}
