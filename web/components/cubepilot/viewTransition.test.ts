import { afterEach, describe, expect, it, vi } from "vitest";

import { withViewTransition } from "./viewTransition";

// The morph is the browser's, so what is worth testing is the wiring around it:
// that a browser without View Transitions (or a reader who asked for less motion)
// gets a plain navigation, and that the transition is not resolved before the
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
    stubReducedMotion(false);
    const { started } = stubTransition();
    let arrived = false;
    // Resolve on the third frame, the way a route that is still rendering does.
    let frames = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames += 1;
      if (frames === 3) arrived = true;
      cb(0);
      return frames;
    });

    withViewTransition(
      () => {},
      () => arrived,
    );
    await started[0];

    expect(frames).toBeGreaterThanOrEqual(3);
  });

  it("gives up rather than holding a transition open for a destination that never arrives", async () => {
    stubReducedMotion(false);
    const { started } = stubTransition();
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    });
    const now = vi.spyOn(Date, "now");
    let clock = 0;
    now.mockImplementation(() => (clock += 1000)); // every frame is a second

    withViewTransition(
      () => {},
      () => false,
    );
    await started[0];

    now.mockRestore();
    expect(clock).toBeGreaterThan(600);
  });
});
