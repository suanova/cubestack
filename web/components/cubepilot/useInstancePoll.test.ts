import { createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { INSTANCE_POLL_MAX_MS, INSTANCE_POLL_MS, useInstancePoll } from "./useInstancePoll";

// No JSX: the repo's tsconfig is Next's (jsx: preserve), which vitest's import
// analysis cannot transform. Same approach as the other component suites.

const Harness = ({ active, poll }: { active: boolean; poll: () => Promise<boolean | null> }) => {
  useInstancePoll(active, poll);
  return null;
};

describe("useInstancePoll", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (props: { active: boolean; poll: () => Promise<boolean | null> }) => {
    act(() => {
      root.render(h(Harness, props));
    });
  };

  /** Let `ms` of wall clock pass, flushing the poll's promise as it lands. */
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  const setHidden = (hidden: boolean) => {
    Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    setHidden(false);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("asks promptly, then settles at the cap while the instance does not exist", async () => {
    const poll = vi.fn(async () => false);
    render({ active: true, poll });

    // The reader who enables the assistant in another tab waits one base
    // window, not a backed-off one.
    await advance(INSTANCE_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    // A long enough stretch for the growth to reach the cap (each window at
    // least doubles the wait, so a few cap windows are plenty).
    await advance(INSTANCE_POLL_MAX_MS * 6);
    const settled = poll.mock.calls.length;
    expect(settled).toBeGreaterThan(1);

    // Steady state: one ask per cap window, not one per base window.
    await advance(INSTANCE_POLL_MAX_MS);
    expect(poll.mock.calls.length).toBe(settled + 1);
    await advance(INSTANCE_POLL_MAX_MS);
    expect(poll.mock.calls.length).toBe(settled + 2);
  });

  it("stays on the base cadence while the instance exists", async () => {
    const poll = vi.fn(async () => true);
    render({ active: true, poll });

    await advance(120_000);
    expect(poll).toHaveBeenCalledTimes(24);
  });

  it("stays on the base cadence when the answer is unknown or the poll throws", async () => {
    // null: the status read failed, which says nothing about the instance.
    const unknown = vi.fn(async () => null);
    render({ active: true, poll: unknown });
    await advance(60_000);
    expect(unknown).toHaveBeenCalledTimes(12);

    const throwing = vi.fn(async () => {
      throw new Error("status unreadable");
    });
    render({ active: true, poll: throwing });
    await advance(60_000);
    expect(throwing).toHaveBeenCalledTimes(12);
  });

  it("returns to the base cadence once the instance appears", async () => {
    let exists = false;
    const poll = vi.fn(async () => exists);
    render({ active: true, poll });
    await advance(INSTANCE_POLL_MAX_MS * 6); // settled at the cap
    const settled = poll.mock.calls.length;

    exists = true;
    await advance(INSTANCE_POLL_MAX_MS); // the wait already armed when it appeared
    expect(poll.mock.calls.length).toBe(settled + 1);

    await advance(INSTANCE_POLL_MS);
    expect(poll.mock.calls.length).toBe(settled + 2);
  });

  it("asks at once when the tab becomes visible again, and nothing while it is hidden", async () => {
    const poll = vi.fn(async () => false);
    render({ active: true, poll });
    await advance(INSTANCE_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    setHidden(true);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(poll).toHaveBeenCalledTimes(1);

    // Back in front of the reader: ask now, not after the backed-off wait.
    setHidden(false);
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(0);
    expect(poll).toHaveBeenCalledTimes(2);
  });

  it("does not restart the cadence on a re-render, which re-creates the poll closure", async () => {
    let calls = 0;
    render({ active: true, poll: async () => (calls++, false) });
    await advance(INSTANCE_POLL_MAX_MS * 6); // settled at the cap
    const settled = calls;

    render({ active: true, poll: async () => (calls++, false) });
    await advance(INSTANCE_POLL_MAX_MS * 2);
    expect(calls).toBe(settled + 2);
  });

  it("polls nothing while inactive, and starts when it becomes active", async () => {
    const poll = vi.fn(async () => false);
    render({ active: false, poll });
    await advance(60_000);
    expect(poll).not.toHaveBeenCalled();

    render({ active: true, poll });
    await advance(INSTANCE_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);
  });

  it("does not stack a second chain when the tab is looked at mid-ask", async () => {
    let first = true;
    let releaseFirst: (v: boolean | null) => void = () => {};
    const poll = vi.fn(async () => {
      if (first) {
        first = false;
        return await new Promise<boolean | null>((r) => {
          releaseFirst = r;
        });
      }
      return false;
    });
    render({ active: true, poll });
    await advance(INSTANCE_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1); // the first ask is in flight

    // Looked at while that ask is in flight: the answer on its way is stale, so
    // one follow-up is owed — but starting it here would leave two chains
    // arming timers, of which `timer` remembers one.
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(poll).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseFirst(false);
      await Promise.resolve();
    });
    expect(poll).toHaveBeenCalledTimes(2); // the follow-up, at once

    await advance(60_000);
    // One chain at the cap: 15s, 30s, 45s, 60s past the follow-up. Two chains
    // would be ~10 asks.
    expect(poll.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it("stops on unmount", async () => {
    const poll = vi.fn(async () => false);
    render({ active: true, poll });
    await advance(INSTANCE_POLL_MS);
    expect(poll).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
    await advance(120_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
