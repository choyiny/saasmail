import { useEffect, useRef } from "react";
import { dispatchSuggestedReplyReady } from "@/lib/suggested-reply-events";
import { dispatchExportReady } from "@/lib/export-events";
import { showToast } from "@/lib/toast";

const INITIAL_RECONNECT_MS = 1_000;
/** A burst of AI filings reloads the list once. */
const MAIL_REFRESH_DEBOUNCE_MS = 1_500;
const MAX_RECONNECT_MS = 60_000;

// Close codes that indicate the server will keep rejecting us, so we stop
// reconnecting. 1008 = policy violation (per RFC 6455); 4401/4403 are reserved
// app-level codes we use for auth failures when the server upgrades and then
// immediately closes with an explicit code.
const TERMINAL_CLOSE_CODES = new Set([1008, 4401, 4403]);

export interface RealtimeEmailReceived {
  inbox?: string;
}

export function useRealtimeUpdates(
  onEmailReceived: (event: RealtimeEmailReceived) => void,
  onShouldPromptPush?: () => void,
) {
  // Keep the latest callback in a ref so we don't bake a stale closure into
  // the long-lived socket lifecycle.
  const callbackRef = useRef(onEmailReceived);
  callbackRef.current = onEmailReceived;
  const promptRef = useRef(onShouldPromptPush);
  promptRef.current = onShouldPromptPush;

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let reconnectDelay = INITIAL_RECONNECT_MS;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    function scheduleReconnect() {
      if (stopped) return;
      // Jitter between 0.85x and 1.15x to avoid thundering-herd on redeploy.
      const jitter = 0.85 + Math.random() * 0.3;
      const delay = Math.min(reconnectDelay * jitter, MAX_RECONNECT_MS);
      reconnectTimeout = setTimeout(connect, delay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
    }

    function connect() {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      ws = new WebSocket(
        `${protocol}//${window.location.host}/api/notifications/stream`,
      );

      ws.onopen = () => {
        // Successful connection — reset the backoff window.
        reconnectDelay = INITIAL_RECONNECT_MS;
      };

      ws.onmessage = (event) => {
        // Server only sends string frames; ignore binary just in case.
        if (typeof event.data !== "string") return;
        try {
          const data = JSON.parse(event.data);
          if (data.type === "email_received") {
            callbackRef.current({
              inbox: typeof data.inbox === "string" ? data.inbox : undefined,
            });
            promptRef.current?.();
          } else if (data.type === "mail_refresh") {
            // Mail changed out of band (the AI filed it): reload, as for new
            // mail, without announcing anything, and once for a burst.
            const inbox =
              typeof data.inbox === "string" ? data.inbox : undefined;
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
              refreshTimer = null;
              callbackRef.current({ inbox });
            }, MAIL_REFRESH_DEBOUNCE_MS);
          } else if (
            data.type === "export_ready" &&
            typeof data.inbox === "string" &&
            typeof data.jobId === "string"
          ) {
            // A mailbox export this person asked for can be downloaded.
            dispatchExportReady({ inbox: data.inbox, jobId: data.jobId });
            showToast({
              kind: "success",
              message: `Your export of ${data.inbox} is ready.`,
              action: {
                label: "Open",
                onClick: (dismiss) => {
                  dismiss();
                  window.location.assign("/settings#data");
                },
              },
            });
          } else if (
            data.type === "suggested_reply" &&
            typeof data.inbox === "string" &&
            typeof data.emailId === "string"
          ) {
            dispatchSuggestedReplyReady({
              inbox: data.inbox,
              emailId: data.emailId,
            });
          }
        } catch {}
      };

      ws.onclose = (event) => {
        if (stopped) return;
        if (TERMINAL_CLOSE_CODES.has(event.code)) return;
        scheduleReconnect();
      };

      ws.onerror = () => ws?.close();
    }

    connect();

    return () => {
      stopped = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (refreshTimer) clearTimeout(refreshTimer);
      ws?.close();
    };
  }, []);
}
