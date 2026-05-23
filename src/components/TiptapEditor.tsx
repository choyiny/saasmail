import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { ResizableImage } from "./ResizableImage";
import { useEffect, useRef, useState } from "react";

interface TiptapEditorProps {
  content: string;
  onUpdate: (html: string) => void;
  placeholder?: string;
  className?: string;
  /** Override the default 2 MB per-image cap. */
  maxImageBytes?: number;
}

const DEFAULT_MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** Read a File into a `data:image/...;base64,...` URL. */
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/**
 * Convert image files into base64 data-URI <img> nodes and insert them
 * at `pos` (or the current selection if pos is undefined). Returns an
 * error message if any file was rejected (too big / not an image),
 * else null. Files that pass are inserted even if a later sibling
 * fails — partial success beats all-or-nothing.
 */
async function insertImageFiles(
  editor: Editor,
  files: File[],
  maxBytes: number,
  pos?: number,
): Promise<string | null> {
  let errMsg: string | null = null;
  let insertPos = pos;
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      errMsg = `${file.name} isn't an image`;
      continue;
    }
    if (file.size > maxBytes) {
      const mb = (maxBytes / (1024 * 1024)).toFixed(1);
      errMsg = `${file.name} exceeds the ${mb} MB limit`;
      continue;
    }
    try {
      const src = await readImageAsDataUrl(file);
      const chain = editor.chain().focus();
      if (insertPos !== undefined) {
        chain.insertContentAt(insertPos, { type: "image", attrs: { src } });
        // Advance the insertion point so multi-file drops stack in order.
        insertPos += 1;
      } else {
        chain.setImage({ src });
      }
      chain.run();
    } catch {
      errMsg = `Failed to read ${file.name}`;
    }
  }
  return errMsg;
}

export default function TiptapEditor({
  content,
  onUpdate,
  placeholder: placeholderText,
  className,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
}: TiptapEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Inline error surface for rejected images (oversize / wrong type).
  const [imageError, setImageError] = useState<string | null>(null);
  const maxBytesRef = useRef(maxImageBytes);
  maxBytesRef.current = maxImageBytes;
  // The editor handle is read inside editorProps callbacks (handleDrop /
  // handlePaste). It isn't available when useEditor's options are first
  // built, so we route through a ref that we populate via onCreate.
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: placeholderText || "Start writing",
        emptyEditorClass: "is-editor-empty",
      }),
      ResizableImage.configure({
        inline: false,
        allowBase64: true,
        HTMLAttributes: { class: "notion-image" },
      }),
    ],
    content,
    onCreate: ({ editor }) => {
      editorRef.current = editor as Editor;
    },
    onUpdate: ({ editor }) => {
      onUpdate(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "notion-editor focus:outline-none",
      },
      handleDrop(view, event, _slice, moved) {
        // Let tiptap handle drags within the document (node moves).
        if (moved) return false;
        const dt = (event as DragEvent).dataTransfer;
        if (!dt || dt.files.length === 0) return false;
        const images = Array.from(dt.files).filter((f) =>
          f.type.startsWith("image/"),
        );
        if (images.length === 0) return false;
        event.preventDefault();
        const ed = editorRef.current;
        if (!ed) return false;
        const drag = event as DragEvent;
        const coords = view.posAtCoords({
          left: drag.clientX,
          top: drag.clientY,
        });
        const pos = coords?.pos;
        void insertImageFiles(ed, images, maxBytesRef.current, pos).then(
          (err) => setImageError(err),
        );
        return true;
      },
      handlePaste(_view, event) {
        const items = (event as ClipboardEvent).clipboardData?.items;
        if (!items) return false;
        const images: File[] = [];
        for (const item of Array.from(items)) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const file = item.getAsFile();
            if (file) images.push(file);
          }
        }
        if (images.length === 0) return false;
        event.preventDefault();
        const ed = editorRef.current;
        if (!ed) return false;
        void insertImageFiles(ed, images, maxBytesRef.current).then((err) =>
          setImageError(err),
        );
        return true;
      },
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content]);

  if (!editor) return null;

  return (
    <div className={`notion-editor-wrapper relative ${className ?? ""}`}>
      {/* Floating toolbar */}
      <div className="notion-toolbar">
        <div className="flex items-center gap-0.5">
          <ToolbarButton
            onClick={() => editor.chain().focus().setParagraph().run()}
            active={editor.isActive("paragraph") && !editor.isActive("heading")}
            title="Text"
          >
            Text
          </ToolbarButton>
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 1 }).run()
            }
            active={editor.isActive("heading", { level: 1 })}
            title="Heading 1"
          >
            H1
          </ToolbarButton>
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
            active={editor.isActive("heading", { level: 2 })}
            title="Heading 2"
          >
            H2
          </ToolbarButton>
          <ToolbarButton
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 3 }).run()
            }
            active={editor.isActive("heading", { level: 3 })}
            title="Heading 3"
          >
            H3
          </ToolbarButton>

          <Separator />

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBold().run()}
            active={editor.isActive("bold")}
            title="Bold"
          >
            <span className="font-bold">B</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleItalic().run()}
            active={editor.isActive("italic")}
            title="Italic"
          >
            <span className="italic">I</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleCode().run()}
            active={editor.isActive("code")}
            title="Inline code"
          >
            <span className="font-mono text-[10px]">&lt;/&gt;</span>
          </ToolbarButton>

          <Separator />

          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            active={editor.isActive("bulletList")}
            title="Bullet list"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="8" y1="6" x2="21" y2="6" />
              <line x1="8" y1="12" x2="21" y2="12" />
              <line x1="8" y1="18" x2="21" y2="18" />
              <circle
                cx="3.5"
                cy="6"
                r="1.5"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="3.5"
                cy="12"
                r="1.5"
                fill="currentColor"
                stroke="none"
              />
              <circle
                cx="3.5"
                cy="18"
                r="1.5"
                fill="currentColor"
                stroke="none"
              />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive("orderedList")}
            title="Numbered list"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="10" y1="6" x2="21" y2="6" />
              <line x1="10" y1="12" x2="21" y2="12" />
              <line x1="10" y1="18" x2="21" y2="18" />
              <text
                x="2"
                y="8"
                fontSize="8"
                fill="currentColor"
                stroke="none"
                fontFamily="sans-serif"
              >
                1
              </text>
              <text
                x="2"
                y="14"
                fontSize="8"
                fill="currentColor"
                stroke="none"
                fontFamily="sans-serif"
              >
                2
              </text>
              <text
                x="2"
                y="20"
                fontSize="8"
                fill="currentColor"
                stroke="none"
                fontFamily="sans-serif"
              >
                3
              </text>
            </svg>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            active={editor.isActive("blockquote")}
            title="Quote"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
              <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z" />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            active={editor.isActive("codeBlock")}
            title="Code block"
          >
            <span className="font-mono text-[10px]">{"{ }"}</span>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().setHorizontalRule().run()}
            title="Divider"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <line x1="2" y1="12" x2="22" y2="12" />
            </svg>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => fileInputRef.current?.click()}
            title="Insert image"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
          </ToolbarButton>
        </div>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          // Reset so picking the same file twice in a row still fires.
          e.target.value = "";
          if (files.length === 0) return;
          void insertImageFiles(editor, files, maxBytesRef.current).then(
            (err) => setImageError(err),
          );
        }}
      />

      {imageError && (
        <div
          role="alert"
          className="mt-2 rounded-[6px] border border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
        >
          {imageError}
          <button
            type="button"
            onClick={() => setImageError(null)}
            className="ml-2 underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Editor area */}
      <div className="notion-editor-content">
        <EditorContent
          editor={editor}
          className="h-full [&>.tiptap]:h-full [&>.tiptap]:min-h-full"
        />
      </div>
    </div>
  );
}

function ToolbarButton({
  onClick,
  active,
  children,
  title,
}: {
  onClick: () => void;
  active?: boolean;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      className={`flex items-center justify-center rounded px-2 py-1.5 text-[11px] font-medium transition-colors ${
        active
          ? "bg-accent/15 text-accent"
          : "text-text-tertiary hover:bg-bg-muted hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className="mx-0.5 h-4 w-px bg-border" />;
}
