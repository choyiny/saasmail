import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { useEffect } from "react";
import { Plugin, PluginKey } from "@tiptap/pm/state";

interface TiptapEditorProps {
  content: string;
  onUpdate: (html: string) => void;
  placeholder?: string;
  className?: string;
}

/** ProseMirror plugin that adds drag handles to top-level block nodes. */
function createDragHandlePlugin() {
  const pluginKey = new PluginKey("dragHandle");
  let dragHandleEl: HTMLDivElement | null = null;
  let hoveredPos: number | null = null;

  return new Plugin({
    key: pluginKey,
    view(editorView) {
      dragHandleEl = document.createElement("div");
      dragHandleEl.className = "drag-handle";
      dragHandleEl.setAttribute("draggable", "true");
      dragHandleEl.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="3" r="1.5"/><circle cx="11" cy="3" r="1.5"/><circle cx="5" cy="8" r="1.5"/><circle cx="11" cy="8" r="1.5"/><circle cx="5" cy="13" r="1.5"/><circle cx="11" cy="13" r="1.5"/></svg>`;
      dragHandleEl.style.display = "none";
      editorView.dom.parentElement?.appendChild(dragHandleEl);

      dragHandleEl.addEventListener("dragstart", (e) => {
        if (hoveredPos === null) return;
        const resolved = editorView.state.doc.resolve(hoveredPos);
        const node = resolved.nodeAfter;
        if (!node) return;

        const from = hoveredPos;
        const to = from + node.nodeSize;
        const tr = editorView.state.tr;
        tr.setSelection(
          editorView.state.selection.constructor === undefined
            ? editorView.state.selection
            : (editorView.state.selection as any).constructor.create(
                editorView.state.doc,
                from,
                to,
              ),
        );

        // Set drag data
        const slice = editorView.state.doc.slice(from, to);
        e.dataTransfer?.setData("application/x-block-drag", JSON.stringify({ from, to }));
        e.dataTransfer?.setData("text/html", "");
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = "move";
        }

        // Visual feedback
        dragHandleEl!.classList.add("dragging");
      });

      dragHandleEl.addEventListener("dragend", () => {
        dragHandleEl!.classList.remove("dragging");
      });

      return {
        destroy() {
          dragHandleEl?.remove();
          dragHandleEl = null;
        },
      };
    },
    props: {
      handleDOMEvents: {
        mousemove(view, event) {
          if (!dragHandleEl) return false;

          const editorRect = view.dom.getBoundingClientRect();
          const pos = view.posAtCoords({
            left: editorRect.left + 1,
            top: event.clientY,
          });

          if (!pos) {
            dragHandleEl.style.display = "none";
            hoveredPos = null;
            return false;
          }

          // Find the top-level node
          const resolved = view.state.doc.resolve(pos.pos);
          const depth = resolved.depth;
          if (depth === 0) {
            dragHandleEl.style.display = "none";
            hoveredPos = null;
            return false;
          }

          const topLevelPos = resolved.before(1);
          const topLevelNode = view.state.doc.nodeAt(topLevelPos);
          if (!topLevelNode) {
            dragHandleEl.style.display = "none";
            hoveredPos = null;
            return false;
          }

          hoveredPos = topLevelPos;

          // Position the drag handle
          const nodeDOM = view.nodeDOM(topLevelPos);
          if (nodeDOM && nodeDOM instanceof HTMLElement) {
            const nodeRect = nodeDOM.getBoundingClientRect();
            const parentRect = view.dom.parentElement!.getBoundingClientRect();
            dragHandleEl.style.display = "flex";
            dragHandleEl.style.top = `${nodeRect.top - parentRect.top + 2}px`;
            dragHandleEl.style.left = `${nodeRect.left - parentRect.left - 28}px`;
          }

          return false;
        },
        mouseleave() {
          if (dragHandleEl) {
            dragHandleEl.style.display = "none";
            hoveredPos = null;
          }
          return false;
        },
        drop(view, event) {
          const data = event.dataTransfer?.getData("application/x-block-drag");
          if (!data) return false;

          event.preventDefault();

          const { from: dragFrom, to: dragTo } = JSON.parse(data);
          const dropPos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });

          if (!dropPos) return false;

          // Find the target top-level block
          const resolved = view.state.doc.resolve(dropPos.pos);
          if (resolved.depth === 0) return false;

          const targetPos = resolved.before(1);
          const targetNode = view.state.doc.nodeAt(targetPos);
          if (!targetNode) return false;

          const targetEnd = targetPos + targetNode.nodeSize;

          // Determine insert position (before or after target based on mouse Y)
          const targetDOM = view.nodeDOM(targetPos);
          let insertPos = targetPos;
          if (targetDOM && targetDOM instanceof HTMLElement) {
            const rect = targetDOM.getBoundingClientRect();
            if (event.clientY > rect.top + rect.height / 2) {
              insertPos = targetEnd;
            }
          }

          // Don't drop on self
          if (insertPos >= dragFrom && insertPos <= dragTo) return false;

          const tr = view.state.tr;
          const draggedContent = view.state.doc.slice(dragFrom, dragTo);

          // If dropping after the dragged content, adjust position
          if (insertPos > dragFrom) {
            tr.delete(dragFrom, dragTo);
            const adjustedPos = insertPos - (dragTo - dragFrom);
            tr.insert(adjustedPos, draggedContent.content);
          } else {
            tr.insert(insertPos, draggedContent.content);
            tr.delete(
              dragFrom + draggedContent.content.size,
              dragTo + draggedContent.content.size,
            );
          }

          view.dispatch(tr);
          return true;
        },
      },
    },
  });
}

/** Drop indicator plugin — shows a blue line where the block will be dropped. */
function createDropIndicatorPlugin() {
  const pluginKey = new PluginKey("dropIndicator");
  let indicatorEl: HTMLDivElement | null = null;

  return new Plugin({
    key: pluginKey,
    view(editorView) {
      indicatorEl = document.createElement("div");
      indicatorEl.className = "drop-indicator";
      indicatorEl.style.display = "none";
      editorView.dom.parentElement?.appendChild(indicatorEl);

      return {
        destroy() {
          indicatorEl?.remove();
          indicatorEl = null;
        },
      };
    },
    props: {
      handleDOMEvents: {
        dragover(view, event) {
          const data = event.dataTransfer?.types.includes(
            "application/x-block-drag",
          );
          if (!data || !indicatorEl) return false;

          event.preventDefault();
          if (event.dataTransfer) {
            event.dataTransfer.dropEffect = "move";
          }

          const pos = view.posAtCoords({
            left: event.clientX,
            top: event.clientY,
          });

          if (!pos) {
            indicatorEl.style.display = "none";
            return false;
          }

          const resolved = view.state.doc.resolve(pos.pos);
          if (resolved.depth === 0) {
            indicatorEl.style.display = "none";
            return false;
          }

          const targetPos = resolved.before(1);
          const targetNode = view.state.doc.nodeAt(targetPos);
          if (!targetNode) {
            indicatorEl.style.display = "none";
            return false;
          }

          const targetDOM = view.nodeDOM(targetPos);
          if (targetDOM && targetDOM instanceof HTMLElement) {
            const rect = targetDOM.getBoundingClientRect();
            const parentRect = view.dom.parentElement!.getBoundingClientRect();
            const isBottom = event.clientY > rect.top + rect.height / 2;

            indicatorEl.style.display = "block";
            indicatorEl.style.top = `${(isBottom ? rect.bottom : rect.top) - parentRect.top}px`;
            indicatorEl.style.left = `${rect.left - parentRect.left}px`;
            indicatorEl.style.width = `${rect.width}px`;
          }

          return false;
        },
        dragleave(view, event) {
          if (indicatorEl) {
            indicatorEl.style.display = "none";
          }
          return false;
        },
        drop() {
          if (indicatorEl) {
            indicatorEl.style.display = "none";
          }
          return false;
        },
      },
    },
  });
}

export default function TiptapEditor({
  content,
  onUpdate,
  placeholder: placeholderText,
  className,
}: TiptapEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({
        placeholder: placeholderText || "Start writing, or press '/' for commands...",
        emptyEditorClass: "is-editor-empty",
      }),
    ],
    content,
    onUpdate: ({ editor }) => {
      onUpdate(editor.getHTML());
    },
    editorProps: {
      attributes: {
        class: "notion-editor focus:outline-none",
      },
    },
  });

  useEffect(() => {
    if (editor && content !== editor.getHTML()) {
      editor.commands.setContent(content);
    }
  }, [content]);

  useEffect(() => {
    if (!editor) return;

    // Register plugins after editor is ready
    const plugins = [createDragHandlePlugin(), createDropIndicatorPlugin()];
    const { state } = editor.view;
    const newState = state.reconfigure({
      plugins: [...state.plugins, ...plugins],
    });
    editor.view.updateState(newState);

    return () => {
      // Cleanup handled by plugin destroy()
    };
  }, [editor]);

  if (!editor) return null;

  return (
    <div className={`notion-editor-wrapper relative ${className ?? ""}`}>
      {/* Floating toolbar */}
      <div className="notion-toolbar">
        <div className="flex items-center gap-0.5">
          <ToolbarButton
            onClick={() => editor.chain().focus().setParagraph().run()}
            active={
              editor.isActive("paragraph") && !editor.isActive("heading")
            }
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><circle cx="3.5" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="3.5" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            active={editor.isActive("orderedList")}
            title="Numbered list"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><text x="2" y="8" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">1</text><text x="2" y="14" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">2</text><text x="2" y="20" fontSize="8" fill="currentColor" stroke="none" fontFamily="sans-serif">3</text></svg>
          </ToolbarButton>
          <ToolbarButton
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
            active={editor.isActive("blockquote")}
            title="Quote"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z"/></svg>
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="2" y1="12" x2="22" y2="12"/></svg>
          </ToolbarButton>
        </div>
      </div>

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
          : "text-text-tertiary hover:bg-hover hover:text-text-secondary"
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Separator() {
  return <div className="mx-0.5 h-4 w-px bg-border-dark" />;
}
