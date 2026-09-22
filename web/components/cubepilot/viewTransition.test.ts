import { afterEach, describe, expect, it, vi } from "vitest";

import { withViewTransition } from "./viewTransition";

// The morph is the browser's, so what is worth testing is the wiring around it:
// that a browser without View Transitions (or a reader who asked for less motion)
// gets a plain navigation, and that the callback does not resolve before the
// destination exists — a callback that returns early leaves the browser morphing
// the old screen into itself, which looks like no animation at all.

function stubTransition() {
  // Behaves like the real API: the callback runs (that is where the navigation
  // happens), and what it returns is what the browser waits for.
  const started: Array<Promise<void> | void> = [];
  const startViewTransition = vi.fn((cb: () => void | Promise<void>) => {
    started.push(cb());
    return { finished: Promise.resolve() };
  });
  Object.defineProperty(document, "startViewTransition", { value: startViewTransition, configurable: true });
  return { started, startViewTransition };
}

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: reduce })),
  );
}

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).startViewTransition;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("withViewTransition", () => {
  it("navigates plainly when the browser has no view transitions", () => {
    const navigate = vi.fn();
    withViewTransition(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("navigates plainly when the reader asked for less motion", () => {
    stubReducedMotion(true);
    const { startViewTransition } = stubTransition();
    const navigate = vi.fn();

    withViewTransition(navigate);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(startViewTransition).not.toHaveBeenCalled();
  });

  it("runs the navigation inside a transition when it has one", () => {
    stubReducedMotion(false);
    const { started } = stubTransition();
    const navigate = vi.fn();

    withViewTransition(navigate);

    expect(started).toHaveLength(1);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("waits for the destination marker before resolving the transition", async () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { started } = stubTransition();
    let checks = 0;

    withViewTransition(
      () => {},
      () => ++checks >= 3,
    );
    await vi.advanceTimersByTimeAsync(200);
    await started[0];

    expect(checks).toBeGreaterThanOrEqual(3);
  });

  it("does not wait on animation frames, which stop once a route change is underway", async () => {
    // The regression this exists for: a frame-based wait looked correct and hung
    // in the app — with the frames gone the callback never resolved, the
    // transition never left its "capturing" phase, and the reader saw no
    // animation at all. Timers keep firing there.
    stubReducedMotion(false);
    const { started } = stubTransition();
    const raf = vi.fn();
    vi.stubGlobal("requestAnimationFrame", raf);

    withViewTransition(
      () => {},
      () => false, // never arrives: only the deadline can end it
    );
    await started[0];

    expect(raf).not.toHaveBeenCalled();
  });

  it("ends at its deadline rather than holding a transition open forever", async () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const { started } = stubTransition();
    let checks = 0;

    withViewTransition(
      () => {},
      () => {
        checks += 1;
        return false;
      },
    );
    await vi.advanceTimersByTimeAsync(2000);
    await started[0];

    // Polled until the deadline, then given up on — never left pending.
    expect(checks).toBeGreaterThan(5);
  });
});
