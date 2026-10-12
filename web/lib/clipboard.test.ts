import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

// The three states the portal is actually served in: a secure context where the
// Clipboard API exists, the platform's own plain-HTTP deployment where it does
// not, and a secure context where the user refused the permission.

/** Install (or remove) `navigator.clipboard`, which jsdom does not define. */
function stubClipboard(api: { writeText: (v: string) => Promise<void> } | undefined) {
  Object.defineProperty(navigator, "clipboard", { value: api, configurable: true, writable: true });
}

let execCommand: ReturnType<typeof vi.fn>;

/** jsdom does not implement document.execCommand at all. */
function stubExecCommand(result: boolean) {
  execCommand = vi.fn(() => result);
  Object.defineProperty(document, "execCommand", { value: execCommand, configurable: true, writable: true });
}

afterEach(() => {
  stubClipboard(undefined);
  Reflect.deleteProperty(document, "execCommand");
  vi.restoreAllMocks();
});

describe("copyText", () => {
  it("uses the Clipboard API where the context has one", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard({ writeText });
    stubExecCommand(false);

    expect(await copyText("https://dev.example/ws/env")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("https://dev.example/ws/env");
    // Nothing was typed into the document: the API path is the whole copy.
    expect(execCommand).not.toHaveBeenCalled();
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to a textarea where the Clipboard API is absent", async () => {
    // Measured on cs7: plain HTTP, isSecureContext false, navigator.clipboard
    // undefined. This is the branch the optional chain used to swallow.
    stubClipboard(undefined);
    stubExecCommand(true);

    expect(await copyText("kubectl -n project-a get secret t -o jsonpath=…")).toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    // The temporary textarea is gone again, and the original selection survives
    // it — a user reading a selected line should still have it selected.
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back when the Clipboard API refuses", async () => {
    // A refused permission (or an unfocused document) rejects; the textarea path
    // can still succeed, so the rejection is not the answer to report.
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    stubClipboard({ writeText });
    stubExecCommand(true);

    expect(await copyText("endpoint")).toBe(true);
    expect(writeText).toHaveBeenCalled();
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports a failure neither path could complete", async () => {
    stubClipboard(undefined);
    stubExecCommand(false);

    expect(await copyText("endpoint")).toBe(false);
  });

  it("leaves the keyboard on the button that was pressed", async () => {
    stubClipboard(undefined);
    // `select()` focuses the textarea, which is why the textarea is what the
    // stub focuses: removing a focused element drops focus to <body>, and the
    // next Tab then starts over from the top of the page.
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        (document.querySelector("textarea") as HTMLTextAreaElement).focus();
        return true;
      }),
    });
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    expect(await copyText("https://dev.example/ws/env")).toBe(true);

    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("copies the text it was given, not the element's own wrapping", async () => {
    stubClipboard(undefined);
    let copied = "";
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      writable: true,
      value: vi.fn(() => {
        copied = (document.querySelector("textarea") as HTMLTextAreaElement).value;
        return true;
      }),
    });

    const value = "kubectl -n project-a get secret jupyter-nlp-ln-jupyter-token -o jsonpath='{.data.token}' | base64 -d";
    expect(await copyText(value)).toBe(true);
    expect(copied).toBe(value);
  });
});
