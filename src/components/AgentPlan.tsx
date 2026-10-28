import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle, Circle, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  getAgentPlan,
  onAgentPlan,
  type AgentPlan as AgentPlanData,
  type AgentPlanStepStatus,
} from "@/lib/agent-plan";

/**
 * The "Agent Plan" tab. Renders whatever plan a connected WebMCP agent has
 * published via the `visualize_plan` tool as a live checklist, so the user can
 * watch what the agent intends to do — and how far it's got — while inference
 * is still running. Empty until an agent publishes a plan.
 */
export default function AgentPlan() {
  const [plan, setPlan] = useState<AgentPlanData | null>(() => getAgentPlan());

  useEffect(() => onAgentPlan(setPlan), []);

  if (!plan || plan.steps.length === 0) {
    return <EmptyState />;
  }

  const done = plan.steps.filter((s) => s.status === "done").length;
  const total = plan.steps.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;
  const activeStep = plan.steps.find((s) => s.status === "active") ?? null;

  return (
    <div className="smooth-scroll flex h-full min-h-0 flex-col overflow-y-auto bg-card">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-6 sm:py-8">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-bg-subtle">
            <Bot size={16} className="text-text-secondary" />
          </span>
          <h2 className="text-base font-semibold tracking-[-0.01em] text-text-primary">
            {plan.title || "Agent plan"}
          </h2>
          {activeStep && <span className="pt-sdot accent ml-1 animate-pulse" />}
        </div>

        {/* Progress */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-xs text-text-secondary">
            <span>
              {done} of {total} done
            </span>
            <span className="tabular font-medium">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          {/* Current step — surfaces "who's being read right now" even when the
              list runs long. */}
          {activeStep && (
            <div className="mt-2 flex items-center gap-2 text-[13px] text-text-secondary">
              <Loader2
                size={13}
                className="shrink-0 animate-spin text-accent"
              />
              <span className="min-w-0 truncate">
                <span className="text-text-tertiary">Now:</span>{" "}
                {activeStep.label}
              </span>
            </div>
          )}
        </div>

        {/* Result — the finished output, kept at the top so it's the first
            thing read once the work is done. */}
        {plan.result && (
          <div className="mt-4 rounded-2xl border border-border bg-bg-subtle p-4">
            <p className="font-label mb-2 text-text-tertiary">Result</p>
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
              {plan.result}
            </p>
          </div>
        )}

        {/* Steps */}
        <ol className="mt-5 overflow-hidden rounded-2xl border border-border bg-card p-1.5 shadow-card">
          {plan.steps.map((step, i) => (
            <li
              key={i}
              className={cn(
                "flex items-start gap-2.5 rounded-xl px-3 transition-colors",
                step.status === "done" ? "py-1.5" : "py-2.5",
                step.status === "active" && "bg-accent-subtle",
              )}
            >
              <StepIcon status={step.status} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "break-words",
                    step.status === "done"
                      ? "text-[13px] text-text-tertiary line-through decoration-text-tertiary/40"
                      : "text-sm text-text-primary",
                  )}
                >
                  {step.label}
                </p>
                {step.detail && (
                  <p
                    className={cn(
                      "mt-0.5 break-words text-[12px]",
                      step.status === "error"
                        ? "text-destructive"
                        : "text-text-secondary",
                    )}
                  >
                    {step.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: AgentPlanStepStatus }) {
  const base = "mt-0.5 shrink-0";
  if (status === "active")
    return (
      <Loader2 size={16} className={cn(base, "animate-spin text-accent")} />
    );
  if (status === "done")
    return <Check size={14} className={cn(base, "text-success")} />;
  if (status === "error")
    return <AlertCircle size={16} className={cn(base, "text-destructive")} />;
  return <Circle size={16} className={cn(base, "text-border-strong")} />;
}

function EmptyState() {
  return (
    <div className="pt-empty h-full min-h-0 bg-card">
      <span className="ic">
        <Bot size={18} />
      </span>
      <h2 className="text-base font-semibold text-text-primary">
        No agent plan yet
      </h2>
      <p className="max-w-md text-[13.5px] text-text-secondary">
        Connect a WebMCP-capable agent (ChatGPT's in-app browser, or Chrome with
        WebMCP enabled) and ask it to work your inbox. It reads the playbook via
        the{" "}
        <code className="font-code rounded bg-bg-muted px-1 py-0.5 text-[12px] text-text-primary">
          get_playbook
        </code>{" "}
        tool, then calls{" "}
        <code className="font-code rounded bg-bg-muted px-1 py-0.5 text-[12px] text-text-primary">
          visualize_plan
        </code>{" "}
        to lay out its steps here — so you can watch the plan fill in and tick
        off while it works, instead of staring at a spinner.
      </p>
      <p className="max-w-md text-[12.5px] text-text-tertiary">
        Try: “summarize all my unread email”, “draft replies to everything
        unread”, or “enroll new contacts into the onboarding sequence”.
      </p>
    </div>
  );
}
