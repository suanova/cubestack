import { describe, expect, it, vi } from "vitest";

import {
  getPaneObjectSnapshot,
  getServerPaneObjectSnapshot,
  setPaneObject,
  subscribePaneObject,
} from "./paneObject";

// The shell's one use for this is "would the floating assistant be a second copy
// of what is on screen", so the contract worth pinning is that a MODEL selection
// is announced and that the server's answer keeps the prerendered HTML as it is.

describe("the pane's selected object", () => {
  it("reports the server snapshot as the assistant, so SSR hides the floating chat as before", () => {
    expect(getServerPaneObjectSnapshot()).toBe("agent");
  });

  it("announces a change to a model, and back to the assistant", () => {
    const seen = vi.fn();
    const unsubscribe = subscribePaneObject(seen);

    setPaneObject("model");
    expect(getPaneObjectSnapshot()).toBe("model");
    expect(seen).toHaveBeenCalledTimes(1);

    setPaneObject("agent");
    expect(getPaneObjectSnapshot()).toBe("agent");
    expect(seen).toHaveBeenCalledTimes(2);

    unsubscribe();
    setPaneObject("model");
    expect(seen).toHaveBeenCalledTimes(2);
    setPaneObject(null);
  });

  it("stays quiet when the selection is unchanged", () => {
    setPaneObject("model");
    const seen = vi.fn();
    const unsubscribe = subscribePaneObject(seen);

    setPaneObject("model");

    expect(seen).not.toHaveBeenCalled();
    unsubscribe();
    setPaneObject(null);
  });
});
