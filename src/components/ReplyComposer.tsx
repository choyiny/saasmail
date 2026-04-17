import { useState, useEffect, useMemo } from "react";
import { X } from "lucide-react";
import TiptapEditor from "@/components/TiptapEditor";
import { replyToEmail, fetchTemplates, type EmailTemplate } from "@/lib/api";
import { getFromLabel } from "@/lib/format";

interface ReplyComposerProps {
  emailId: string;
  personName: string | null;
  personEmail: string;
  recipients: string[];
  senderIdentities: Array<{ email: string; displayName: string | null }>;
  onClose: () => void;
  onSent: () => void;
}

type Tab = "freeform" | "template";

function extractVariables(subject: string, bodyHtml: string): string[] {
  const vars = new Set<string>();
  const regex = /\{\{(\w+)\}\}/g;
  for (const src of [subject, bodyHtml]) {
    let m: RegExpExecArray | null;
    while ((m = regex.exec(src)) !== null) {
      vars.add(m[1]);
    }
  }
  return Array.from(vars);
}

export default function ReplyComposer({
  emailId,
  personName,
  personEmail,
  recipients,
  senderIdentities,
  onClose,
  onSent,
}: ReplyComposerProps) {
  const [tab, setTab] = useState<Tab>("freeform");
  const [fromAddress, setFromAddress] = useState(recipients[0] ?? "");
  const [bodyHtml, setBodyHtml] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Template state
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedSlug, setSelectedSlug] = useState("");
  const [templateVars, setTemplateVars] = useState<Record<string, string>>({});
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState("");

  const selectedTemplate =
    templates.find((t) => t.slug === selectedSlug) ?? null;

  const requiredVars = useMemo(() => {
    if (!selectedTemplate) return [];
    return extractVariables(
      selectedTemplate.subject,
      selectedTemplate.bodyHtml,
    );
  }, [selectedTemplate]);

  // Auto-fill variables when template or person changes
  useEffect(() => {
    if (!selectedTemplate) return;
    const vars: Record<string, string> = {};
    for (const v of requiredVars) {
      if (v.toLowerCase() === "name" && personName) {
        vars[v] = personName;
      } else if (v.toLowerCase() === "email") {
        vars[v] = personEmail;
      } else {
        vars[v] = templateVars[v] ?? "";
      }
    }
    setTemplateVars(vars);
  }, [selectedSlug, requiredVars.join(",")]);

  // Fetch templates when switching to template tab
  useEffect(() => {
    if (tab !== "template" || templates.length > 0) return;
    setTemplatesLoading(true);
    setTemplatesError("");
    fetchTemplates()
      .then(setTemplates)
      .catch(() => setTemplatesError("Failed to load templates"))
      .finally(() => setTemplatesLoading(false));
  }, [tab]);

  async function handleSend() {
    setSending(true);
    setError("");
    try {
      if (tab === "freeform") {
        await replyToEmail(emailId, { bodyHtml, fromAddress });
      } else {
        if (!selectedSlug) {
          setError("Select a template");
          setSending(false);
          return;
        }
        await replyToEmail(emailId, {
          templateSlug: selectedSlug,
          variables: templateVars,
          fromAddress,
        });
      }
      onSent();
      onClose();
    } catch {
      setError("Failed to send reply");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="border-t border-border bg-white shrink-0">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <span className="text-xs font-semibold text-text-primary">Reply</span>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text-secondary"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-2 space-y-2">
        {/* From picker */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-text-tertiary shrink-0">From</label>
          <select
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
            className="flex-1 bg-transparent border border-border rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            {recipients.map((r) => (
              <option key={r} value={r}>
                {getFromLabel(r, senderIdentities)}
              </option>
            ))}
          </select>
        </div>

        {/* Tab toggle */}
        <div className="flex gap-1">
          <button
            onClick={() => setTab("freeform")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              tab === "freeform"
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-bg-muted"
            }`}
          >
            Freeform
          </button>
          <button
            onClick={() => setTab("template")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              tab === "template"
                ? "bg-accent text-white"
                : "text-text-secondary hover:bg-bg-muted"
            }`}
          >
            Template
          </button>
        </div>

        {/* Content area */}
        {tab === "freeform" ? (
          <TiptapEditor
            content={bodyHtml}
            onUpdate={setBodyHtml}
            placeholder="Write your reply..."
          />
        ) : (
          <div className="space-y-2">
            {templatesLoading ? (
              <p className="text-xs text-text-tertiary">Loading templates...</p>
            ) : templatesError ? (
              <p className="text-xs text-destructive">{templatesError}</p>
            ) : (
              <>
                <select
                  value={selectedSlug}
                  onChange={(e) => setSelectedSlug(e.target.value)}
                  className="w-full bg-transparent border border-border rounded-md px-2 py-1.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                >
                  <option value="">Select a template...</option>
                  {templates.map((t) => (
                    <option key={t.slug} value={t.slug}>
                      {t.name}
                    </option>
                  ))}
                </select>

                {selectedTemplate && (
                  <>
                    {/* Subject preview */}
                    <div className="text-xs text-text-secondary">
                      <span className="text-text-tertiary">Subject: </span>
                      {selectedTemplate.subject}
                    </div>

                    {/* Body preview */}
                    <div
                      className="rounded-md border border-border bg-white p-3 text-xs text-text-secondary max-h-32 overflow-auto"
                      dangerouslySetInnerHTML={{
                        __html: selectedTemplate.bodyHtml,
                      }}
                    />

                    {/* Variable inputs */}
                    {requiredVars.length > 0 && (
                      <div className="space-y-1.5">
                        <span className="text-[10px] text-text-tertiary uppercase tracking-wider">
                          Variables
                        </span>
                        {requiredVars.map((v) => (
                          <div key={v} className="flex items-center gap-2">
                            <label className="text-xs text-text-tertiary font-mono shrink-0 w-20 truncate">
                              {`{{${v}}}`}
                            </label>
                            <input
                              value={templateVars[v] ?? ""}
                              onChange={(e) =>
                                setTemplateVars((prev) => ({
                                  ...prev,
                                  [v]: e.target.value,
                                }))
                              }
                              className="flex-1 bg-transparent border border-border rounded-md px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                            />
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between pt-1">
          {error && <span className="text-xs text-destructive">{error}</span>}
          <div className="ml-auto">
            <button
              onClick={handleSend}
              disabled={sending}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50 transition-colors"
            >
              {sending ? "Sending..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
