"use client";

// The poll that lets a reader in without a reload: prompt while the caller's
// AgentInstance is absent, backing off once that absence is established (it
// cannot change on its own), and asking at once when the tab is looked at.

import { useEffect, useRef } from "react";

/** The starting wait, and the one kept whenever the answer is not a definite
 *  absence. */
export const INSTANCE_POLL_MS = 5_000;
/** The backed-off wait: what a page left open with no instance costs settled. */
export const INSTANCE_POLL_MAX_MS = 15_000;

/** Ask `poll` on a cadence while `active`: `false` (absent) backs it off, `true`
 *  and `null` (could not tell) keep the base wait, and a visible tab asks at
 *  once. */
export function useInstancePoll(active: boolean, poll: () => Promise<boolean | null>): void {
  // The panes re-create the poll closure every render; reading it through a ref
  // keeps a render from re-arming the timer and undoing the backoff.
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  });

  useEffect(() => {
    if (!active) return;
    let wait = INSTANCE_POLL_MS;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    // One ask at a time, and at most one timer: a visibility change during an
    // in-flight ask queues a follow-up instead of starting a second chain
    // (two chains each arm a timer, and only the last handle is clearable).
    let asking = false;
    let askAgain = false;

    const arm = () => {
      timer = setTimeout(() => void tick(), wait);
    };

    const tick = async () => {
      if (stopped || asking) return;
      asking = true;
      let exists: boolean | null = null;
      try {
        exists = await pollRef.current();
      } catch {
        // A poll that throws says nothing about the instance: keep asking.
      }
      asking = false;
      if (stopped) return;
      wait = exists === false ? Math.min(wait * 2, INSTANCE_POLL_MAX_MS) : INSTANCE_POLL_MS;
      if (askAgain) {
        askAgain = false;
        void tick();
        return;
      }
      arm();
    };

    const onVisibilityChange = () => {
      if (document.hidden || stopped) return;
      if (asking) {
        askAgain = true;
        return;
      }
      if (timer) clearTimeout(timer);
      void tick();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    arm();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [active]);
}
