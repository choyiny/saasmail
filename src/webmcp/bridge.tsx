import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import EnrollSequenceModal from "@/components/EnrollSequenceModal";
import { fetchPerson, fetchStats } from "@/lib/api";

export interface StagedAction {
  title: string;
  summary: string;
  run: () => Promise<void>;
}

export interface ComposeSeed {
  from?: string;
  to?: string;
  subject?: string;
  bodyHtml?: string;
  cc?: { email: string; name?: string | null }[];
}

export interface WebMcpBridge {
  navigate: (path: string) => void;
  openCompose: (seed: ComposeSeed) => void;
  openEnroll: (personId: string) => void;
  stageForConfirmation: (action: StagedAction) => void;
}

const BridgeContext = createContext<WebMcpBridge | null>(null);

export function useWebMcpBridge(): WebMcpBridge {
  const ctx = useContext(BridgeContext);
  if (!ctx)
    throw new Error("useWebMcpBridge must be used within WebMcpBridgeProvider");
  return ctx;
}

/** Data the bridge resolves for the enroll modal once `openEnroll(personId)`
 * is called — EnrollSequenceModal requires personName/personEmail/recipients
 * that the bridge's callers don't have on hand. */
interface EnrollData {
  personId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
}

export function WebMcpBridgeProvider({
  navigate,
  openCompose,
  children,
}: {
  navigate: (path: string) => void;
  openCompose: (seed: ComposeSeed) => void;
  children: ReactNode;
}) {
  const [enrollPersonId, setEnrollPersonId] = useState<string | null>(null);
  const [enrollData, setEnrollData] = useState<EnrollData | null>(null);
  const [staged, setStaged] = useState<StagedAction | null>(null);
  const [busy, setBusy] = useState(false);

  const openEnroll = useCallback((personId: string) => {
    setEnrollData(null);
    setEnrollPersonId(personId);
  }, []);
  const stageForConfirmation = useCallback(
    (action: StagedAction) => setStaged(action),
    [],
  );

  const bridge = useMemo<WebMcpBridge>(
    () => ({ navigate, openCompose, openEnroll, stageForConfirmation }),
    [navigate, openCompose, openEnroll, stageForConfirmation],
  );

  // Resolve the props EnrollSequenceModal actually requires whenever a
  // personId is staged. Does not block any other bridge functionality.
  useEffect(() => {
    if (!enrollPersonId) return;
    let cancelled = false;
    Promise.all([fetchPerson(enrollPersonId), fetchStats()])
      .then(([person, stats]) => {
        if (cancelled) return;
        setEnrollData({
          personId: enrollPersonId,
          personName: person.name,
          personEmail: person.email,
          recipients:
            stats.recipients && stats.recipients.length > 0
              ? stats.recipients
              : [person.recipient],
        });
      })
      .catch(() => {
        if (!cancelled) setEnrollPersonId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [enrollPersonId]);

  const closeEnroll = useCallback(() => {
    setEnrollPersonId(null);
    setEnrollData(null);
  }, []);

  const confirm = useCallback(async () => {
    if (!staged) return;
    setBusy(true);
    try {
      await staged.run();
    } finally {
      setBusy(false);
      setStaged(null);
    }
  }, [staged]);

  return (
    <BridgeContext.Provider value={bridge}>
      {children}
      {enrollPersonId &&
        enrollData &&
        enrollData.personId === enrollPersonId && (
          <EnrollSequenceModal
            personId={enrollData.personId}
            personName={enrollData.personName}
            personEmail={enrollData.personEmail}
            recipients={enrollData.recipients}
            open={true}
            onClose={closeEnroll}
            onEnrolled={closeEnroll}
          />
        )}
      {staged && (
        <div
          role="dialog"
          aria-label={staged.title}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        >
          <div className="w-full max-w-md rounded-xl bg-white p-5 shadow-xl">
            <h2 className="text-lg font-semibold text-text-primary">
              {staged.title}
            </h2>
            <p className="mt-2 whitespace-pre-wrap text-sm text-text-secondary">
              {staged.summary}
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setStaged(null)}
                disabled={busy}
                className="rounded-lg px-3 py-2 text-sm text-text-secondary hover:bg-neutral-100"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirm}
                disabled={busy}
                className="rounded-lg bg-text-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-60"
              >
                {busy ? "Working…" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}
    </BridgeContext.Provider>
  );
}
