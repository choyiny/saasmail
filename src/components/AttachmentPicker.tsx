import { useRef, useCallback, ReactNode } from "react";
import { Paperclip } from "lucide-react";

export interface AttachmentPickerProps {
  /** Called with newly picked or dropped files. Parent merges into its own list. */
  onFilesAdded: (files: File[]) => void;
  /** When true, the children render a drop-target overlay on dragover. */
  enableDragDrop?: boolean;
  /** Optional class for the paperclip button. */
  buttonClassName?: string;
  /** Optional label override (default: paperclip icon). */
  buttonLabel?: ReactNode;
  /** Wrap a region (compose form, reply form) as a drag-drop target. */
  children?: ReactNode;
}

export default function AttachmentPicker({
  onFilesAdded,
  enableDragDrop = false,
  buttonClassName,
  buttonLabel,
  children,
}: AttachmentPickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handlePick = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files ? Array.from(e.target.files) : [];
      if (files.length > 0) onFilesAdded(files);
      // Reset so picking the same file twice fires onChange.
      if (inputRef.current) inputRef.current.value = "";
    },
    [onFilesAdded],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (dropped.length > 0) onFilesAdded(dropped);
    },
    [onFilesAdded],
  );

  const preventDefault = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const wrapper = enableDragDrop ? (
    <div
      onDragEnter={preventDefault}
      onDragOver={preventDefault}
      onDrop={handleDrop}
      className="relative"
    >
      {children}
    </div>
  ) : (
    children
  );

  return (
    <>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        className={
          buttonClassName ??
          "inline-flex items-center gap-1 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
        }
        aria-label="Attach files"
      >
        {buttonLabel ?? <Paperclip className="h-4 w-4" />}
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={handlePick}
      />
      {wrapper}
    </>
  );
}
