// The cross-route morph for one surface becoming another: the floating chat panel
// and the full pane's thread carry the same `view-transition-name`, so the browser
// can animate between them — the widget growing into the page, and the page
// shrinking back into the corner — with nothing but the navigation wrapped.
//
// It is the browser's own View Transitions API, not a hand-rolled FLIP: there are
// no rectangles to measure, no timing to babysit, and no second implementation to
// keep in step with the two layouts. Browsers without it, and readers who asked
// for less motion, get the plain navigation — which is also the behaviour every
// entry into the chat page had before this existed.

/** The shared name. One element may carry it at a time, and the two surfaces
 *  already guarantee that: the panel is not rendered on the chat tab (nor the
 *  fab beside it), and the pane's thread is not on any other route. */
export const AGENT_CHAT_TRANSITION = "agent-chat";

/** True when the reader has asked the platform for less motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

type ViewTransitionDocument = Document & {
  startViewTransition?: (callback: () => void | Promise<void>) => unknown;
};

/**
 * Run a route change inside a view transition, when the browser can and the
 * reader has not asked for less motion.
 *
 * `navigate` starts the navigation; `arrived` reports whether the destination is
 * on screen yet. The transition waits for that because it captures the new state
 * when the callback resolves — a callback that returns before the router has
 * committed leaves the browser morphing the old screen into itself, which reads
 * as no animation at all. Callers that know a marker for their destination pass
 * one; the default is two frames, which is enough for a route the shell has
 * already prefetched.
 */
export function withViewTransition(navigate: () => void, arrived?: () => boolean): void {
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== "function" || prefersReducedMotion()) {
    navigate();
    return;
  }
  void doc.startViewTransition(async () => {
    navigate();
    if (!arrived) {
      // Two macrotasks: enough for a route the shell has already prefetched.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      return;
    }
    // Polled on TIMERS, not on animation frames. A frame-based wait looks right
    // and hangs in practice: once a route change is underway the frames stop
    // coming, the callback never resolves, and the transition sits in its
    // "capturing the new state" phase — which the reader sees as no animation at
    // all. Timers keep firing there. (Measured, not assumed: the frame version
    // left `finished` pending past 2.5s on a 250ms transition.)
    const deadline = Date.now() + 600;
    while (Date.now() < deadline && !arrived()) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  });
}
