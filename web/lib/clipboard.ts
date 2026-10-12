// Copying text to the clipboard, in a portal that is served over plain HTTP.
//
// The Clipboard API is only defined in a **secure context**, and the platform's
// own deployment is not one: measured on cs7 the page reports
// `isSecureContext: false`, `origin: http://10.66.3.212`, and both
// `navigator.clipboard` and `navigator.clipboard.writeText` undefined. Every
// "Copy" affordance in the product — the Jupyter endpoint, the `kubectl … get
// secret` line that reads its token, the inference endpoints, the pilot's
// playground — is dead there.
//
// The form that used to be at each of those call sites is the trap, and it is
// worth naming: `navigator.clipboard?.writeText(v).then(…)`. The optional chain
// is on the *absent object*, so the whole expression short-circuits to
// `undefined` — `.then` is never reached, nothing is thrown, no promise is
// rejected, and the button is indistinguishable from a broken one. Absence has
// to be a branch, and the branch needs something to fall back to.

/**
 * Copy `value` to the clipboard, and report whether it got there.
 *
 * The Clipboard API is preferred where it exists (it is asynchronous, works
 * without touching the DOM, and respects the page's focus). Where it does not —
 * any non-secure context — `document.execCommand("copy")` on a temporary
 * textarea is the only mechanism available. It is deprecated and still
 * implemented by every browser the portal runs in, which is why it is the
 * fallback rather than a feature detection the caller has to make.
 *
 * A rejected `writeText` (permission denied, or a document that is not focused)
 * also falls back rather than reporting a failure: the textarea path can still
 * succeed where the API refused.
 */
export async function copyText(value: string): Promise<boolean> {
  const api = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (api?.writeText) {
    try {
      await api.writeText(value);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }
  return execCommandCopy(value);
}

function execCommandCopy(value: string): boolean {
  if (typeof document === "undefined") return false;
  // `select()` focuses the textarea in every browser that implements it, so the
  // element the user pressed loses focus the moment this runs. Removing the
  // focused textarea afterwards would leave the keyboard on <body>, where the
  // next Tab starts from the top of the page — the copy button must still be
  // where the user left it.
  const focused = document.activeElement;
  const area = document.createElement("textarea");
  area.value = value;
  // Off-screen rather than hidden: a display:none or visibility:hidden element
  // cannot hold a selection, so there would be nothing for the copy to take.
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    area.select();
    // iOS ignores select() on a readonly element without a range.
    area.setSelectionRange(0, value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
    // The page's own selection is not the copy's to lose: a user selecting a
    // line to read it should still have it selected afterwards.
    if (previous && selection) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
    if (focused instanceof HTMLElement && focused.isConnected) focused.focus();
  }
}
