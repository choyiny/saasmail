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

  const openEnroll = useCallback((personId: string) => {
    setEnrollData(null);
    setEnrollPersonId(personId);
  }, []);

  const bridge = useMemo<WebMcpBridge>(
    () => ({ navigate, openCompose, openEnroll }),
    [navigate, openCompose, openEnroll],
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
    </BridgeContext.Provider>
  );
}
