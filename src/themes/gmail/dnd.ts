import { useEffect, useState } from "react";

/**
 * Drag and drop of list rows onto nav folders. The list owns the rows,
 * the shell owns the nav, so they talk through window events: the list
 * announces a drag (and how many rows), the nav announces a drop target.
 */

export type DropTarget = "inbox" | "starred" | "snoozed" | "archive" | "trash";

const DRAG_EVENT = "gmail:drag";
const DROP_EVENT = "gmail:drop";
export const DRAG_MIME = "application/x-saasmail-rows";

let current: { count: number } | null = null;

export function startRowDrag(count: number) {
  current = { count };
  window.dispatchEvent(new Event(DRAG_EVENT));
}

export function endRowDrag() {
  current = null;
  window.dispatchEvent(new Event(DRAG_EVENT));
}

export function dropOn(target: DropTarget) {
  window.dispatchEvent(new CustomEvent(DROP_EVENT, { detail: target }));
}

export function onRowDrop(handler: (t: DropTarget) => void): () => void {
  const fn = (e: Event) => handler((e as CustomEvent<DropTarget>).detail);
  window.addEventListener(DROP_EVENT, fn);
  return () => window.removeEventListener(DROP_EVENT, fn);
}

/** Number of rows being dragged, or 0. Re-renders on drag start/end. */
export function useRowDrag(): number {
  const [n, setN] = useState(current?.count ?? 0);
  useEffect(() => {
    const on = () => setN(current?.count ?? 0);
    window.addEventListener(DRAG_EVENT, on);
    return () => window.removeEventListener(DRAG_EVENT, on);
  }, []);
  return n;
}

/** A small "N conversations" ghost for the drag image. */
export function dragGhost(count: number): HTMLElement {
  const el = document.createElement("div");
  el.textContent =
    count === 1 ? "Move 1 conversation" : `Move ${count} conversations`;
  el.className = "gm-drag-ghost";
  el.style.position = "fixed";
  el.style.top = "-1000px";
  document.body.appendChild(el);
  window.setTimeout(() => el.remove(), 0);
  return el;
}
