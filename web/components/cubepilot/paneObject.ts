// Which object the assistant's chat tab is currently showing: the CubePilot agent, or
// one of the inference models.
//
// The shell needs it for exactly one decision — whether the floating chat would be
// a second copy of what is already on screen. Hiding it is right while the AGENT is
// selected, because that pane IS the conversation; it is wrong while a MODEL is,
// because a model playground is a different chat and the assistant is worth
// reaching from it. The pane owns the selection, so it publishes it here rather
// than the shell guessing from the route.

export type PaneObject = "agent" | "model" | null;

/** What the pane shows before anything is selected, and what the server snapshot
 *  reports: the assistant is the pane's own default (see ChatPane's mount effect),
 *  so the prerendered HTML keeps the floating chat hidden on the chat tab exactly
 *  as it is today, and a model selection — which only happens in the browser —
 *  reveals it after hydration. */
const DEFAULT_PANE_OBJECT: PaneObject = "agent";

let current: PaneObject = null;
const listeners = new Set<() => void>();

export function setPaneObject(next: PaneObject): void {
  if (current === next) return;
  current = next;
  for (const listener of listeners) listener();
}

export function subscribePaneObject(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export const getPaneObjectSnapshot = (): PaneObject => current;
export const getServerPaneObjectSnapshot = (): PaneObject => DEFAULT_PANE_OBJECT;
