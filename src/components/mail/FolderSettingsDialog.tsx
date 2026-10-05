import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  MAILBOX_COLORS,
  updateMailbox,
  type Mailbox,
  type MailboxColor,
} from "@/lib/api";
import { FOLDER_COLOR_CLASSES } from "./folder-colors";

export const MAX_AI_DESCRIPTION = 300;

/** A custom folder's name, colour and AI description. */
export default function FolderSettingsDialog({
  mailbox,
  onClose,
  onSaved,
}: {
  mailbox: Mailbox | null;
  onClose: () => void;
  onSaved: (mailbox: Mailbox) => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState<MailboxColor | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mailbox) return;
    setName(mailbox.name);
    setColor(mailbox.color);
    setDescription(mailbox.aiDescription ?? "");
    setError(null);
  }, [mailbox]);

  async function save() {
    if (!mailbox || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      onSaved(
        await updateMailbox(mailbox.id, {
          name: name.trim(),
          color,
          aiDescription: description.trim() || null,
        }),
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn’t save the folder");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={mailbox !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Edit folder</DialogTitle>
          <DialogDescription>
            A colour shows on the messages in this folder. A description lets
            the AI file mail into it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1">
            <label
              htmlFor="folder-name"
              className="text-xs font-medium text-text-secondary"
            >
              Name
            </label>
            <input
              id="folder-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="w-full rounded-[6px] border border-border bg-card px-3 py-2 text-sm text-text-primary"
            />
          </div>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-text-secondary">
              Colour
            </legend>
            <div className="flex flex-wrap gap-2" role="radiogroup">
              <button
                type="button"
                role="radio"
                aria-checked={color === null}
                aria-label="No colour"
                onClick={() => setColor(null)}
                className={`h-6 w-6 rounded-full border border-border bg-card ${
                  color === null ? "ring-2 ring-text-primary ring-offset-1" : ""
                }`}
              />
              {MAILBOX_COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={color === option}
                  aria-label={option}
                  onClick={() => setColor(option)}
                  className={`h-6 w-6 rounded-full ${FOLDER_COLOR_CLASSES[option].dot} ${
                    color === option
                      ? "ring-2 ring-text-primary ring-offset-1"
                      : ""
                  }`}
                />
              ))}
            </div>
          </fieldset>
          <div className="space-y-1">
            <label
              htmlFor="folder-ai-description"
              className="text-xs font-medium text-text-secondary"
            >
              What belongs here? (lets the AI file mail into this folder)
            </label>
            <textarea
              id="folder-ai-description"
              value={description}
              maxLength={MAX_AI_DESCRIPTION}
              rows={3}
              placeholder="e.g. Invoices, receipts and payment questions"
              onChange={(event) => setDescription(event.target.value)}
              className="w-full resize-y rounded-[6px] border border-border bg-card px-3 py-2 text-sm text-text-primary"
            />
            <p className="text-right text-[11px] text-text-tertiary">
              {description.length}/{MAX_AI_DESCRIPTION}
            </p>
          </div>
          {error && (
            <p role="alert" className="text-xs text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[6px] border border-border px-3 py-1.5 text-xs font-medium text-text-secondary hover:bg-bg-muted"
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="folder-settings-save"
              disabled={saving || !name.trim()}
              onClick={() => void save()}
              className="rounded-[6px] bg-text-primary px-3 py-1.5 text-xs font-medium text-white hover:bg-text-primary/90 disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
