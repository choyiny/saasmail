/**
 * Shared state + event bus for the "Agent Plan" view. A WebMCP agent calls the
 * `visualize_plan` tool (repeatedly) to publish the steps it intends to run;
 * the AgentPlan tab renders them as a live checklist so the user can watch
 * progress while long inference is still in flight. Same zero-dependency
 * custom-event pattern as lib/inbox-events.ts.
 */

export type AgentPlanStepStatus = "pending" | "active" | "done" | "error";

export interface AgentPlanStep {
  /** Short label for the step, e.g. "Read unread from Ada Lovelace". */
  label: string;
  status: AgentPlanStepStatus;
  /** Optional extra line under the step (a result, a note, an error). */
  detail?: string;
}

export interface AgentPlan {
  /** Optional plan title, e.g. "Summarize all unread email". */
  title?: string;
  steps: AgentPlanStep[];
}

export const AGENT_PLAN_EVENT = "saasmail:agent-plan";

// Latest plan, kept so the AgentPlan view can render immediately on mount even
// though the events that carry it are transient.
let latestPlan: AgentPlan | null = null;

export function getAgentPlan(): AgentPlan | null {
  return latestPlan;
}

export function dispatchAgentPlan(plan: AgentPlan): void {
  latestPlan = plan;
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AGENT_PLAN_EVENT, { detail: plan }));
}

export function onAgentPlan(handler: (plan: AgentPlan) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (e: Event) => handler((e as CustomEvent<AgentPlan>).detail);
  window.addEventListener(AGENT_PLAN_EVENT, listener);
  return () => window.removeEventListener(AGENT_PLAN_EVENT, listener);
}
