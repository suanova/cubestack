// One-shot handoff of the agent conversation from the floating surface to the
// assistant's chat pane.
//
// Both surfaces drive the same session (SESSION_KEY), so the pane restores the
// same thread on its own — asynchronously, behind a metadata read. Until that
// lands, a reader who has just expanded the widget sees a greeting or an empty
// thread, which reads as "my conversation is gone" rather than "it got bigger".
// Handing the messages over lets the pane paint the thread it is about to
// restore, so the expansion lands on the conversation itself.
//
// In memory, not localStorage: this is a transfer between two components of one
// document, and a reload has nothing to hand over. It is TAKEN rather than read,
// because a payload left behind would seed a later visit with a stale thread.

import type { ThreadMsg } from "@/lib/cubepilot/agentThread";

let pending: ThreadMsg[] | null = null;
const listeners = new Set<() => void>();

/** publishAgentHandoff offers the conversation to whichever surface shows the pane. */
export function publishAgentHandoff(msgs: ThreadMsg[]): void {
  pending = msgs;
  for (const listener of listeners) listener();
}

/** takeAgentHandoff consumes the offer, or returns null when there is none. */
export function takeAgentHandoff(): ThreadMsg[] | null {
  const taken = pending;
  pending = null;
  return taken;
}

/** subscribeAgentHandoff notifies on a new offer. The pane is usually already
 *  mounted when one arrives — its tabs keep their panes alive — so this is a
 *  subscription rather than a read at mount. */
export function subscribeAgentHandoff(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** While its panel is open the floating surface registers a reader for the thread
 *  it is showing, so an entry point that cannot see it — the sidebar's own link to
 *  the chat page — can still offer what it holds. Null when no panel is open. */
let floatingThread: (() => ThreadMsg[]) | null = null;

export function registerFloatingThread(provider: (() => ThreadMsg[]) | null): void {
  floatingThread = provider;
}

/** offerHandoffFromFloatingChat offers the floating panel's thread, when a panel
 *  is open and has one. Every entry into the chat page calls this before
 *  navigating, so the conversation the reader was looking at arrives with them
 *  whichever way they got there. With no panel open there is nothing to hand
 *  over, and the pane restores exactly as it always did — which is also why this
 *  offers nothing rather than an empty thread: an empty offer would paint a
 *  greeting the pane is about to replace anyway. */
export function offerHandoffFromFloatingChat(): void {
  const msgs = floatingThread?.() ?? null;
  if (msgs && msgs.length > 0) publishAgentHandoff(msgs);
}
