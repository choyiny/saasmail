import { useRef, useEffect } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { html } from "@codemirror/lang-html";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/** Syntax colours from the theme tokens, so the editor follows dark mode. */
const tokenHighlight = HighlightStyle.define([
  { tag: [t.tagName, t.angleBracket], color: "var(--sm-accent-ink)" },
  { tag: t.attributeName, color: "var(--sm-run)" },
  { tag: [t.attributeValue, t.string], color: "var(--sm-ok)" },
  { tag: t.comment, color: "var(--sm-faint)", fontStyle: "italic" },
  { tag: [t.keyword, t.processingInstruction], color: "var(--sm-warn)" },
  { tag: t.invalid, color: "var(--sm-bad)" },
]);

interface HtmlCodeEditorProps {
  value: string;
  onChange: (html: string) => void;
  className?: string;
}

export default function HtmlCodeEditor({
  value,
  onChange,
  className,
}: HtmlCodeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        bracketMatching(),
        html(),
        syntaxHighlighting(tokenHighlight),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.domEventHandlers({
          paste(event, view) {
            const htmlData = event.clipboardData?.getData("text/html");
            if (htmlData) {
              event.preventDefault();
              const { from, to } = view.state.selection.main;
              view.dispatch({
                changes: { from, to, insert: htmlData },
              });
              return true;
            }
            return false;
          },
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            onChangeRef.current(update.state.doc.toString());
          }
        }),
        EditorView.theme({
          "&": {
            height: "100%",
            fontSize: "13px",
            backgroundColor: "var(--sm-surface)",
            color: "var(--sm-ink)",
          },
          "&.cm-focused": { outline: "none" },
          ".cm-scroller": {
            overflow: "auto",
            fontFamily: "var(--sm-font-mono)",
            lineHeight: "1.6",
          },
          ".cm-content": { caretColor: "var(--sm-accent)" },
          ".cm-gutters": {
            backgroundColor: "var(--sm-surface-2)",
            color: "var(--sm-faint)",
            border: "none",
            borderRight: "1px solid var(--sm-line)",
          },
          ".cm-activeLine": { backgroundColor: "var(--sm-surface-2)" },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--sm-surface-3)",
            color: "var(--sm-ink-2)",
          },
          ".cm-cursor": { borderLeftColor: "var(--sm-accent)" },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection":
            {
              backgroundColor: "var(--sm-accent-tint-2)",
            },
          ".cm-matchingBracket": {
            backgroundColor: "var(--sm-accent-tint)",
            outline: "1px solid var(--sm-accent-tint-2)",
          },
        }),
      ],
    });

    const view = new EditorView({
      state,
      parent: containerRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Only create the editor once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync external value changes (e.g. loading template from API)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const currentDoc = view.state.doc.toString();
    if (value !== currentDoc) {
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      });
    }
  }, [value]);

  return (
    <div
      ref={containerRef}
      className={`h-full overflow-hidden [&_.cm-editor]:h-full ${className ?? ""}`}
    />
  );
}
