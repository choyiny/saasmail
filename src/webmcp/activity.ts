import type { WebMcpToolDescriptor } from "./types";

/**
 * Lightweight event bus that surfaces live WebMCP tool activity to the UI,
 * mirroring src/lib/toast.ts. WebMCP tools run silently in the browser when a
 * connected agent calls them, so without this the user stares at an idle
 * screen. The <WebMcpActivityFeed/> mounted alongside the tools subscribes to
 * these events and renders a bottom-right stack so the user can watch what the
 * agent is doing in real time.
 */
export const WEBMCP_ACTIVITY_EVENT = "saasmail:webmcp-activity";

export type WebMcpActivityPhase = "running" | "success" | "error";

export interface WebMcpActivity {
  /** Stable id for one tool invocation so running → done updates in place. */
  id: string;
  /** Raw tool name, e.g. "search_emails". */
  tool: string;
  /** Human-friendly label, e.g. "Searching emails". */
  label: string;
  phase: WebMcpActivityPhase;
  /** Short extra context, shown on failure. */
  detail?: string;
  /** Wall-clock duration once the call finished, in ms. */
  durationMs?: number;
}

export function emitWebMcpActivity(activity: WebMcpActivity): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(WEBMCP_ACTIVITY_EVENT, { detail: activity }),
  );
}

/**
 * Human labels for the tools this app registers. Anything not listed falls
 * back to a titleized tool name, so a newly added tool still shows something
 * sensible without touching this map.
 */
const TOOL_LABELS: Record<string, string> = {
  whoami: "Checking your account",
  list_inboxes: "Listing inboxes",
  list_conversations: "Listing conversations",
  list_contacts: "Listing contacts",
  get_contact: "Reading a contact",
  list_emails: "Listing emails",
  read_email: "Reading an email",
  search_emails: "Searching emails",
  list_templates: "Listing templates",
  get_template: "Reading a template",
  list_sequences: "Listing sequences",
  open_contact: "Opening a contact",
  compose_email: "Preparing a draft",
  compose_from_template: "Preparing a draft",
  reply_email: "Drafting a reply",
  mark_read: "Marking as read",
  mark_unread: "Marking as unread",
  delete_email: "Preparing to delete",
  enroll_in_sequence: "Opening enrollment",
};

export function labelForTool(name: string): string {
  return (
    TOOL_LABELS[name] ??
    name.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())
  );
}

function firstText(result: {
  content?: { text?: string }[];
}): string | undefined {
  return result?.content?.[0]?.text;
}

// Monotonic counter so each invocation gets a distinct id even when two calls
// to the same tool overlap.
let sequence = 0;

/**
 * Wrap a tool descriptor so every invocation emits activity events: one
 * "running" when it starts, then "success" or "error" when it settles (a tool
 * that returns an `isError` result counts as an error). The wrapped execute is
 * otherwise transparent — same args, same return value, errors still throw.
 */
export function withActivity(
  descriptor: WebMcpToolDescriptor,
): WebMcpToolDescriptor {
  return {
    ...descriptor,
    execute: async (args, opts) => {
      const id = `${descriptor.name}-${++sequence}`;
      const label = labelForTool(descriptor.name);
      const startedAt =
        typeof performance !== "undefined" ? performance.now() : 0;
      const elapsed = () =>
        typeof performance !== "undefined"
          ? Math.round(performance.now() - startedAt)
          : undefined;

      emitWebMcpActivity({
        id,
        tool: descriptor.name,
        label,
        phase: "running",
      });
      try {
        const result = await descriptor.execute(args, opts);
        emitWebMcpActivity({
          id,
          tool: descriptor.name,
          label,
          phase: result?.isError ? "error" : "success",
          durationMs: elapsed(),
          ...(result?.isError ? { detail: firstText(result) } : {}),
        });
        return result;
      } catch (err) {
        emitWebMcpActivity({
          id,
          tool: descriptor.name,
          label,
          phase: "error",
          detail: (err as Error)?.message,
          durationMs: elapsed(),
        });
        throw err;
      }
    },
  };
}
