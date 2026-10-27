import { useSyncExternalStore } from "react";

/**
 * Small shared state for the portal shell: whether the command palette and
 * the shortcuts sheet are open. (The rail's collapsed state is an account
 * setting: see useDefaultLayoutSettings.)
 */
interface ShellState {
  cmdk: boolean;
  /** The keyboard shortcuts sheet ("?"). */
  keys: boolean;
}

let state: ShellState = {
  cmdk: false,
  keys: false,
};
const listeners = new Set<() => void>();

export const shellStore = {
  get: () => state,
  set(patch: Partial<ShellState>) {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
};

export function useShell<T>(pick: (s: ShellState) => T): T {
  return useSyncExternalStore(shellStore.subscribe, () => pick(state));
}
