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
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-violet/10 ring-1 ring-violet/30">
            <Bot size={15} className="text-violet" />
          </span>
          <h2 className="text-base font-semibold text-text-primary">
            {plan.title || "Agent Plan"}
          </h2>
          {activeStep && (
            <span className="ml-1 h-1.5 w-1.5 animate-pulse rounded-full bg-violet" />
          )}
        </div>

        {/* Progress */}
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between text-[11px] font-medium text-text-tertiary">
            <span>
              {done} of {total} done
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-muted">
            <div
              className="h-full rounded-full bg-violet transition-[width] duration-500 ease-out"
              style={{ width: `${pct}%` }}
            />
          </div>
          {/* Current step — surfaces "who's being read right now" even when the
              list runs long. */}
          {activeStep && (
            <div className="mt-2 flex items-center gap-2 text-[12px] text-text-secondary">
              <Loader2
                size={12}
                className="shrink-0 animate-spin text-violet"
              />
              <span className="min-w-0 truncate">
                <span className="text-text-tertiary">Now:</span>{" "}
                {activeStep.label}
              </span>
            </div>
          )}
        </div>

        {/* Steps */}
        <ol className="mt-5 space-y-1">
          {plan.steps.map((step, i) => (
            <li
              key={i}
              className={cn(
                "flex items-start gap-3 rounded-[8px] px-3 py-2.5 ring-1 transition-colors",
                step.status === "active"
                  ? "bg-violet/[0.04] ring-violet/30"
                  : "ring-transparent",
              )}
            >
              <StepIcon status={step.status} />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "break-words text-sm",
                    step.status === "done"
                      ? "text-text-tertiary line-through decoration-text-tertiary/40"
                      : "text-text-primary",
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

        {plan.result && (
          <div className="mt-5 rounded-[10px] bg-bg-subtle/60 p-4 ring-1 ring-border">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
              Result
            </p>
            <p className="whitespace-pre-wrap break-words text-sm text-text-primary">
              {plan.result}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StepIcon({ status }: { status: AgentPlanStepStatus }) {
  const base = "mt-0.5 shrink-0";
  if (status === "active")
    return (
      <Loader2 size={16} className={cn(base, "animate-spin text-violet")} />
    );
  if (status === "done")
    return (
      <Check
        size={16}
        className={cn(base, "text-emerald-600 dark:text-emerald-400")}
      />
    );
  if (status === "error")
    return <AlertCircle size={16} className={cn(base, "text-destructive")} />;
  return <Circle size={16} className={cn(base, "text-text-tertiary/50")} />;
}

function EmptyState() {
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center bg-card px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-violet/10 ring-1 ring-violet/30">
        <Bot size={22} className="text-violet" />
      </span>
      <h2 className="mt-4 text-base font-semibold text-text-primary">
        No agent plan yet
      </h2>
      <p className="mt-2 max-w-md text-sm text-text-secondary">
        Connect a WebMCP-capable agent (ChatGPT's in-app browser, or Chrome with
        WebMCP enabled) and ask it to work your inbox. It reads the playbook via
        the{" "}
        <code className="rounded bg-bg-muted px-1 py-0.5 text-[12px]">
          get_playbook
        </code>{" "}
        tool, then calls{" "}
        <code className="rounded bg-bg-muted px-1 py-0.5 text-[12px]">
          visualize_plan
        </code>{" "}
        to lay out its steps here — so you can watch the plan fill in and tick
        off while it works, instead of staring at a spinner.
      </p>
      <p className="mt-3 max-w-md text-[12px] text-text-tertiary">
        Try: “summarize all my unread email”, “draft replies to everything
        unread”, or “enroll new contacts into the onboarding sequence”.
      </p>
    </div>
  );
}
