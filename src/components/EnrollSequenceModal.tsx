import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { fetchSequences, enrollPerson, type Sequence } from "@/lib/api";

interface EnrollSequenceModalProps {
  personId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
  open: boolean;
  onClose: () => void;
  onEnrolled: () => void;
}

export default function EnrollSequenceModal({
  personId,
  personName,
  personEmail,
  recipients,
  open,
  onClose,
  onEnrolled,
}: EnrollSequenceModalProps) {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [fromAddress, setFromAddress] = useState(recipients[0] ?? "");
  const [skipSteps, setSkipSteps] = useState<number[]>([]);
  const [delayOverrides, setDelayOverrides] = useState<Record<string, number>>(
    {},
  );
  const [variables, setVariables] = useState<
    Array<{ key: string; value: string }>
  >([]);
  const [submitting, setSubmitting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!open) return;
    setSelectedId("");
    setSkipSteps([]);
    setDelayOverrides({});
    setVariables([]);
    fetchSequences()
      .then(setSequences)
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  const selectedSequence = sequences.find((s) => s.id === selectedId);

  function toggleSkip(order: number) {
    setSkipSteps((prev) =>
      prev.includes(order) ? prev.filter((o) => o !== order) : [...prev, order],
    );
  }

  function setDelay(order: number, hours: number) {
    setDelayOverrides((prev) => ({ ...prev, [order.toString()]: hours }));
  }

  function addVariable() {
    setVariables([...variables, { key: "", value: "" }]);
  }

  function updateVariable(idx: number, field: "key" | "value", val: string) {
    setVariables(
      variables.map((v, i) => (i === idx ? { ...v, [field]: val } : v)),
    );
  }

  function removeVariable(idx: number) {
    setVariables(variables.filter((_, i) => i !== idx));
  }

  async function handleSubmit() {
    if (!selectedId) return;
    setSubmitting(true);

    const varsObj: Record<string, string> = {};
    for (const v of variables) {
      if (v.key.trim()) varsObj[v.key.trim()] = v.value;
    }

    try {
      await enrollPerson(selectedId, {
        personId,
        fromAddress,
        variables: varsObj,
        skipSteps,
        delayOverrides,
      });
      onEnrolled();
      onClose();
    } catch (err: any) {
      alert(err.message || "Failed to enroll person.");
    } finally {
      setSubmitting(false);
    }
  }

  const activeStepCount = selectedSequence
    ? selectedSequence.steps.filter((s) => !skipSteps.includes(s.order)).length
    : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--chrome-scrim)] backdrop-blur-[2px] sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enroll-title"
    >
      <div className="flex max-h-[92dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-2xl border border-border-strong bg-card text-text-primary shadow-overlay sm:rounded-2xl">
        <div className="border-b border-border px-5 py-4">
          <h2
            id="enroll-title"
            className="text-base font-semibold tracking-[-0.01em] text-text-primary"
          >
            Add to sequence
          </h2>
          <p className="mt-0.5 truncate text-[13px] text-text-secondary">
            {personName ?? personEmail}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex flex-col gap-3" aria-busy="true">
              <span className="pt-skel h-9 w-full" />
              <span className="pt-skel h-9 w-full" />
            </div>
          ) : (
            <>
              <label className="mb-4 block">
                <span className="font-label mb-1.5 block text-text-tertiary">
                  Sequence
                </span>
                <select
                  value={selectedId}
                  onChange={(e) => {
                    setSelectedId(e.target.value);
                    setSkipSteps([]);
                    setDelayOverrides({});
                  }}
                  className="h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
                >
                  <option value="">Select a sequence…</option>
                  {sequences.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.steps.length} steps)
                    </option>
                  ))}
                </select>
              </label>

              <label className="mb-4 block">
                <span className="font-label mb-1.5 block text-text-tertiary">
                  Send from
                </span>
                <select
                  value={fromAddress}
                  onChange={(e) => setFromAddress(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border-strong bg-card px-3 text-sm text-text-primary shadow-card focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15"
                >
                  {recipients.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </label>

              {selectedSequence && (
                <div className="mb-4">
                  <p className="font-label mb-1.5 text-text-tertiary">Steps</p>
                  <div className="divide-y divide-border-subtle overflow-hidden rounded-xl border border-border">
                    {selectedSequence.steps.map((step, idx) => {
                      const skipped = skipSteps.includes(step.order);
                      const delay =
                        step.order.toString() in delayOverrides
                          ? delayOverrides[step.order.toString()]
                          : step.delayHours;
                      return (
                        <div
                          key={step.order}
                          className={`flex items-center gap-2.5 px-3 py-2 text-[13px] ${skipped ? "opacity-50" : ""}`}
                        >
                          <input
                            type="checkbox"
                            checked={!skipped}
                            onChange={() => toggleSkip(step.order)}
                            className="h-4 w-4 accent-[var(--sm-accent)]"
                          />
                          <span className="tabular w-5 text-text-tertiary">
                            {idx + 1}
                          </span>
                          <span className="font-code min-w-0 flex-1 truncate text-text-primary">
                            {step.templateSlug}
                          </span>
                          <input
                            type="number"
                            min={0}
                            value={delay}
                            onChange={(e) =>
                              setDelay(
                                step.order,
                                parseInt(e.target.value) || 0,
                              )
                            }
                            className="h-8 rounded-lg border border-border-strong bg-card px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 tabular w-16"
                            disabled={skipped}
                          />
                          <span className="text-xs text-text-tertiary">
                            hrs
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {activeStepCount === 0 && (
                    <p className="mt-1.5 text-xs text-destructive">
                      At least one step must be selected.
                    </p>
                  )}
                </div>
              )}

              <div>
                <p className="font-label mb-1.5 text-text-tertiary">
                  Custom variables
                </p>
                {variables.map((v, idx) => (
                  <div key={idx} className="mb-1.5 flex items-center gap-2">
                    <input
                      type="text"
                      placeholder="key"
                      value={v.key}
                      onChange={(e) =>
                        updateVariable(idx, "key", e.target.value)
                      }
                      className="h-8 rounded-lg border border-border-strong bg-card px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 font-code w-32"
                    />
                    <input
                      type="text"
                      placeholder="value"
                      value={v.value}
                      onChange={(e) =>
                        updateVariable(idx, "value", e.target.value)
                      }
                      className="h-8 rounded-lg border border-border-strong bg-card px-2 text-[13px] text-text-primary focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/15 min-w-0 flex-1"
                    />
                    <button
                      type="button"
                      onClick={() => removeVariable(idx)}
                      aria-label="Remove variable"
                      className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-text-tertiary transition-colors hover:bg-destructive-subtle hover:text-destructive"
                    >
                      &times;
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={addVariable}
                  className="mt-1 text-[13px] font-medium text-accent-subtle-fg hover:underline"
                >
                  + Add variable
                </button>
              </div>
            </>
          )}
        </div>

        <div
          className="flex justify-end gap-2 border-t border-border bg-bg-subtle px-5 py-3"
          style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
        >
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={
              !selectedId || submitting || activeStepCount === 0 || loading
            }
          >
            {submitting ? "Enrolling…" : "Enroll"}
          </Button>
        </div>
      </div>
    </div>
  );
}
