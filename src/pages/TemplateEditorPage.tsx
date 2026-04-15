import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import TiptapEditor from "@/components/TiptapEditor";
import { fetchTemplate, createTemplate, updateTemplate } from "@/lib/api";

export default function TemplateEditorPage() {
  const { slug } = useParams<{ slug: string }>();
  const navigate = useNavigate();
  const isEdit = Boolean(slug);

  const [name, setName] = useState("");
  const [slugValue, setSlugValue] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyHtml, setBodyHtml] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(isEdit);

  useEffect(() => {
    if (slug) {
      fetchTemplate(slug)
        .then((t) => {
          setName(t.name);
          setSlugValue(t.slug);
          setSubject(t.subject);
          setBodyHtml(t.bodyHtml);
        })
        .catch(() => setError("Template not found"))
        .finally(() => setLoading(false));
    }
  }, [slug]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      if (isEdit) {
        await updateTemplate(slug!, { name, subject, bodyHtml });
      } else {
        await createTemplate({ slug: slugValue, name, subject, bodyHtml });
      }
      navigate("/templates");
    } catch {
      setError("Failed to save template");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex-1 p-6">
        <p className="text-xs text-text-tertiary">Loading...</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6">
          <button
            onClick={() => navigate("/templates")}
            className="text-xs text-text-tertiary hover:text-text-secondary"
          >
            &larr; Templates
          </button>
          <h1 className="mt-2 text-sm font-semibold text-text-primary">
            {isEdit ? "Edit Template" : "New Template"}
          </h1>
        </div>

        <form onSubmit={handleSave} className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Welcome Email"
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Slug
            </label>
            <input
              value={slugValue}
              onChange={(e) => setSlugValue(e.target.value)}
              placeholder="welcome-email"
              pattern="[a-z0-9-]+"
              title="Lowercase letters, numbers, and hyphens only"
              disabled={isEdit}
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Subject
            </label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Welcome, {{name}}!"
              required
              className="h-8 w-full rounded-md border border-border-dark bg-input-bg px-3 text-xs text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-text-secondary">
              Body
            </label>
            <TiptapEditor content={bodyHtml} onUpdate={setBodyHtml} />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => navigate("/templates")}
              className="rounded-md px-3 py-1.5 text-xs text-text-secondary hover:bg-hover hover:text-text-primary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
