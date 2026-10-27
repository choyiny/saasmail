import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { FileText, X } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fetchTemplates, type EmailTemplate } from "@/lib/api";
import {
  analyzeTemplateClient,
  isSectionName,
  renderPreview,
} from "@/lib/template-syntax";

/** "Template" button for the compose footer: lists saved templates. */
export function TemplatePicker({
  onChoose,
}: {
  onChoose: (t: EmailTemplate) => void;
}) {
  const [templates, setTemplates] = useState<EmailTemplate[] | null>(null);
  const [error, setError] = useState(false);
  return (
    <DropdownMenu
      modal={false}
      onOpenChange={(open) => {
        if (open && templates === null)
          fetchTemplates()
            .then(setTemplates)
            .catch(() => setError(true));
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          title="Insert a saved template"
          className="inline-flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary data-[state=open]:bg-bg-muted"
        >
          <FileText size={15} />
          <span className="hidden sm:inline">Template</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className="w-72">
        <DropdownMenuLabel>Insert a template</DropdownMenuLabel>
        {error ? (
          <div className="px-2 py-2 text-[13px] text-destructive">
            Couldn't load templates.
          </div>
        ) : templates === null ? (
          <div className="px-2 py-2 text-[13px] text-text-tertiary">
            Loading…
          </div>
        ) : templates.length === 0 ? (
          <div className="px-2 py-2 text-[13px] text-text-tertiary">
            No templates yet.
          </div>
        ) : (
          templates.map((t) => (
            <DropdownMenuItem
              key={t.id}
              onSelect={() => onChoose(t)}
              className="flex-col items-start gap-0"
            >
              <span className="text-[13px] font-medium">{t.name}</span>
              <span className="w-full truncate text-xs text-text-tertiary">
                {t.subject}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/templates" className="text-[13px]">
            Manage templates
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Decode the entities `renderPreview` escapes, for the plain subject. */
function plain(html: string): string {
  const el = document.createElement("textarea");
  el.innerHTML = html;
  return el.value;
}

/** Best guess for common variables from the person being written to. */
function guess(name: string, to: { email: string; name: string | null }) {
  const n = name.toLowerCase().replace(/[^a-z]/g, "");
  const full = to.name?.trim() ?? "";
  if (["firstname", "first", "fname"].includes(n))
    return full.split(/\s+/)[0] ?? "";
  if (["lastname", "last", "lname", "surname"].includes(n))
    return full.split(/\s+/).slice(1).join(" ");
  if (["name", "fullname", "customername", "contactname"].includes(n))
    return full;
  if (["email", "emailaddress"].includes(n)) return to.email;
  return "";
}

/**
 * Fill in a chosen template's variables, then apply it to the draft.
 * Variables we can guess from the recipient (name, first name, email) are
 * prefilled; sections are left out (they need list data the composer
 * doesn't have).
 */
export function TemplateVarsBar({
  template,
  recipient,
  onApply,
  onCancel,
}: {
  template: EmailTemplate;
  recipient: { email: string; name: string | null };
  onApply: (r: { subject: string; bodyHtml: string }) => void;
  onCancel: () => void;
}) {
  const vars = useMemo(() => {
    try {
      const a = analyzeTemplateClient(template.subject, template.bodyHtml);
      return [...a.required, ...a.optional].filter(
        (v, i, all) => !isSectionName(a, v) && all.indexOf(v) === i,
      );
    } catch {
      return [];
    }
  }, [template]);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(vars.map((v) => [v, guess(v, recipient)])),
  );
  const [failed, setFailed] = useState(false);

  const apply = () => {
    try {
      onApply({
        subject: plain(renderPreview(template.subject, values)),
        bodyHtml: renderPreview(template.bodyHtml, values),
      });
    } catch {
      setFailed(true);
    }
  };

  return (
    <div
      className="shrink-0 border-b border-border bg-bg-subtle px-4 py-3 sm:px-5"
      role="group"
      aria-label={`Template: ${template.name}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <FileText size={14} className="text-text-secondary" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-text-primary">
          {template.name}
        </span>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Discard template"
          className="grid h-7 w-7 place-items-center rounded-md text-text-tertiary hover:bg-bg-muted hover:text-text-primary"
        >
          <X size={14} />
        </button>
      </div>
      {vars.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {vars.map((v, i) => (
            <label key={v} className="flex flex-col gap-1">
              <span className="font-mono text-[11px] text-text-tertiary">
                {`{{${v}}}`}
              </span>
              <input
                autoFocus={i === 0}
                value={values[v] ?? ""}
                onChange={(e) =>
                  setValues((prev) => ({ ...prev, [v]: e.target.value }))
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    apply();
                  }
                }}
                className="h-8 rounded-md border border-border-strong bg-card px-2 text-[13px] text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/15"
              />
            </label>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-center justify-end gap-2">
        {failed && (
          <span className="mr-auto text-xs text-destructive" role="alert">
            This template couldn't be filled in. Edit it on the Templates page.
          </span>
        )}
        <span className="mr-auto hidden text-xs text-text-tertiary sm:inline">
          Replaces the subject and message.
        </span>
        <button
          type="button"
          onClick={apply}
          className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-medium text-accent-foreground hover:bg-accent-hover"
        >
          Use template
        </button>
      </div>
    </div>
  );
}
