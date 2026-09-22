import { afterEach, describe, expect, it, vi } from "vitest";

import {
  offerHandoffFromFloatingChat,
  publishAgentHandoff,
  registerFloatingThread,
  subscribeAgentHandoff,
  takeAgentHandoff,
} from "./agentHandoff";
import { newAgentMsg, type ThreadMsg } from "@/lib/cubepilot/agentThread";

// The handoff is the one thing that makes "the widget grew into the page" land on
// the conversation instead of on a greeting: the pane is handed the thread the
// other surface was showing, while its own (asynchronous) restore catches up.
// These cases are the contract that keeps it from becoming a stale cache.

const thread = (): ThreadMsg[] => [newAgentMsg(1)];

describe("agent handoff", () => {
  it("is taken once, so a later visit cannot be seeded with a stale thread", () => {
    publishAgentHandoff(thread());
    expect(takeAgentHandoff()).not.toBeNull();
    // Consumed: the second read finds nothing rather than the same conversation
    // again — a payload left behind would paint over whatever the pane restores
    // next time the reader arrives some other way.
    expect(takeAgentHandoff()).toBeNull();
  });

  it("returns null when nothing was offered", () => {
    expect(takeAgentHandoff()).toBeNull();
  });

  it("notifies a subscriber that is already listening", () => {
    // The pane is usually mounted when the offer arrives (the module's tabs keep
    // their panes alive), so the offer is an event, not a mount-time read.
    const seen = vi.fn();
    const unsubscribe = subscribeAgentHandoff(seen);
    publishAgentHandoff(thread());

    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    publishAgentHandoff(thread());
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("carries the messages themselves, in order", () => {
    const msgs = thread();
    publishAgentHandoff(msgs);
    expect(takeAgentHandoff()).toBe(msgs);
  });
});

describe("offering from the floating panel", () => {
  afterEach(() => {
    registerFloatingThread(null);
  });

  it("offers nothing when no panel is open", () => {
    // The ordinary case: most visits to the chat page are not an expansion, and
    // an empty offer would paint a greeting over the pane's own restore.
    offerHandoffFromFloatingChat();
    expect(takeAgentHandoff()).toBeNull();
  });

  it("offers nothing for a panel that has not said anything yet", () => {
    registerFloatingThread(() => []);
    offerHandoffFromFloatingChat();
    expect(takeAgentHandoff()).toBeNull();
  });

  it("offers what the open panel is showing", () => {
    const msgs = thread();
    registerFloatingThread(() => msgs);
    offerHandoffFromFloatingChat();
    expect(takeAgentHandoff()).toBe(msgs);
  });

  it("stops offering once the panel is gone", () => {
    registerFloatingThread(() => thread());
    registerFloatingThread(null);
    offerHandoffFromFloatingChat();
    expect(takeAgentHandoff()).toBeNull();
  });
});
