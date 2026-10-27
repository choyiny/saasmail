import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export interface SheetAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  hidden?: boolean;
}

/** iOS / Android style bottom action sheet (Outlook mobile "⋯"). */
export default function ActionSheet({
  open,
  onOpenChange,
  title,
  actions,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  title?: string;
  actions: SheetAction[];
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ol-scrim" />
        <Dialog.Content className="ol-sheet" aria-describedby={undefined}>
          <span className="ol-sheet-grip" aria-hidden />
          <Dialog.Title className={cn("ol-sheet-title", !title && "sr-only")}>
            {title || "Actions"}
          </Dialog.Title>
          <div className="flex flex-col">
            {actions
              .filter((a) => !a.hidden)
              .map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className={cn(
                    "ol-sheet-item",
                    a.danger && "text-destructive",
                  )}
                  onClick={() => {
                    onOpenChange(false);
                    a.onSelect();
                  }}
                >
                  <span className="ol-sheet-icon" aria-hidden>
                    {a.icon}
                  </span>
                  {a.label}
                </button>
              ))}
          </div>
          <Dialog.Close asChild>
            <button type="button" className="ol-sheet-cancel">
              Cancel
            </button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
