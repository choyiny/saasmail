/**
 * The block editing surface.
 *
 * Not a reuse of `TiptapEditor.tsx`, deliberately. That component serves the
 * inbox: it emits browser HTML and inlines images as base64 data URIs, which is
 * right for a one-to-one reply and wrong for a newsletter — Gmail strips
 * data-URI images, and the bytes would be duplicated into every recipient's
 * copy. Sharing it would drag newsletter concerns into the reply composer.
 *
 * The editor holds a Tiptap document; `serialize` turns it into the block
 * document that gets saved. It never produces HTML — the compiler does that,
 * on the server at save time and here for the preview, from the same module.
 */

import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  Link2,
  List,
  ListOrdered,
  Quote,
  Minus,
  Image as ImageIcon,
  MousePointerClick,
  Heading1,
  Heading2,
} from "lucide-react";
import { uploadNewsletterAsset } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmailButton, EmailImage } from "./nodes";
import {
  BUTTON_NODE,
  IMAGE_NODE,
  deserialize,
  serialize,
  type TiptapNode,
} from "./serialize";
import type { BlockDocument } from "@worker/lib/blocks/schema";

interface BlockEditorProps {
  /** The stored document, or null for a new template. */
  value: BlockDocument | null;
  onChange: (doc: BlockDocument) => void;
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "rounded-[4px] p-1.5 text-text-secondary transition-colors hover:bg-bg-muted hover:text-text-primary",
        active && "bg-bg-muted text-text-primary",
      )}
    >
      {children}
    </button>
  );
}

function Toolbar({
  editor,
  onInsertImage,
  uploading,
}: {
  editor: Editor;
  onInsertImage: () => void;
  uploading: boolean;
}) {
  const chain = () => editor.chain().focus();

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-bg-subtle/40 px-2 py-1.5">
      <ToolbarButton
        title="Bold"
        active={editor.isActive("bold")}
        onClick={() => chain().toggleBold().run()}
      >
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Italic"
        active={editor.isActive("italic")}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Underline"
        active={editor.isActive("underline")}
        onClick={() => chain().toggleUnderline().run()}
      >
        <UnderlineIcon size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Strikethrough"
        active={editor.isActive("strike")}
        onClick={() => chain().toggleStrike().run()}
      >
        <Strikethrough size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Link"
        active={editor.isActive("link")}
        onClick={() => {
          const previous = editor.getAttributes("link").href ?? "";
          const href = window.prompt(
            "Link URL — a {{variable}} is allowed",
            previous,
          );
          if (href === null) return;
          if (href === "") {
            chain().unsetLink().run();
            return;
          }
          chain().setLink({ href }).run();
        }}
      >
        <Link2 size={14} />
      </ToolbarButton>

      <span className="mx-1 h-4 w-px bg-border" />

      <ToolbarButton
        title="Heading 1"
        active={editor.isActive("heading", { level: 1 })}
        onClick={() => chain().toggleHeading({ level: 1 }).run()}
      >
        <Heading1 size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Heading 2"
        active={editor.isActive("heading", { level: 2 })}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Bulleted list"
        active={editor.isActive("bulletList")}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Numbered list"
        active={editor.isActive("orderedList")}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Quote"
        active={editor.isActive("blockquote")}
        onClick={() => chain().toggleBlockquote().run()}
      >
        <Quote size={14} />
      </ToolbarButton>

      <span className="mx-1 h-4 w-px bg-border" />

      <ToolbarButton
        title="Separator"
        onClick={() => chain().setHorizontalRule().run()}
      >
        <Minus size={14} />
      </ToolbarButton>
      <ToolbarButton
        title="Button"
        onClick={() =>
          chain()
            .insertContent({
              type: BUTTON_NODE,
              attrs: { label: "Read more", href: "", align: "center" },
            })
            .run()
        }
      >
        <MousePointerClick size={14} />
      </ToolbarButton>
      <ToolbarButton
        title={uploading ? "Uploading…" : "Image"}
        onClick={onInsertImage}
      >
        <ImageIcon size={14} className={uploading ? "animate-pulse" : ""} />
      </ToolbarButton>
    </div>
  );
}

export default function BlockEditor({ value, onChange }: BlockEditorProps) {
  const [uploadError, setUploadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // `onChange` is called from inside a Tiptap callback registered once; a ref
  // keeps that callback from capturing a stale closure over the parent's state.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        // Neither has a sane rendering in email, and the block schema has no
        // representation for them — enabling them would let an author write
        // content the compiler would silently drop.
        code: false,
        codeBlock: false,
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false },
      }),
      EmailButton,
      EmailImage,
      Placeholder.configure({
        placeholder: "Write your newsletter… use the toolbar to add blocks",
      }),
    ],
    content: value ? (deserialize(value) as never) : undefined,
    editorProps: {
      attributes: {
        class:
          "prose prose-sm max-w-none px-5 py-4 focus:outline-none min-h-[420px]",
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(serialize(editor.getJSON() as TiptapNode));
    },
  });

  const insertUploaded = useCallback(
    async (file: File) => {
      if (!editor) return;
      setUploadError("");
      setUploading(true);
      try {
        const asset = await uploadNewsletterAsset(file);
        editor
          .chain()
          .focus()
          .insertContent({
            type: IMAGE_NODE,
            attrs: {
              src: asset.url,
              alt: "",
              width: `${asset.width}px`,
              align: "center",
            },
          })
          .run();
      } catch (err) {
        // Surfaced inline rather than as a toast: a rejected upload needs to
        // stay on screen next to the block the author was building.
        setUploadError(
          err instanceof Error ? err.message : "Could not upload that image",
        );
      } finally {
        setUploading(false);
      }
    },
    [editor],
  );

  // A pasted or dropped image uploads rather than becoming a data URI.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;

    const imageFrom = (e: ClipboardEvent | DragEvent): File | null => {
      const items =
        (e as ClipboardEvent).clipboardData?.files ??
        (e as DragEvent).dataTransfer?.files;
      const file = items?.[0];
      return file && file.type.startsWith("image/") ? file : null;
    };

    const handle = (e: ClipboardEvent | DragEvent) => {
      const file = imageFrom(e);
      if (!file) return;
      e.preventDefault();
      void insertUploaded(file);
    };

    dom.addEventListener("paste", handle as EventListener);
    dom.addEventListener("drop", handle as EventListener);
    return () => {
      dom.removeEventListener("paste", handle as EventListener);
      dom.removeEventListener("drop", handle as EventListener);
    };
  }, [editor, insertUploaded]);

  if (!editor) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        editor={editor}
        uploading={uploading}
        onInsertImage={() => fileInput.current?.click()}
      />
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void insertUploaded(file);
          e.target.value = "";
        }}
      />
      {uploadError && (
        <p
          role="alert"
          className="border-b border-border bg-red-500/5 px-5 py-2 text-xs text-red-600 dark:text-red-400"
        >
          {uploadError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
