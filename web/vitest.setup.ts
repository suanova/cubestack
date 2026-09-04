// jsdom does not implement matchMedia; theme-storage's prefers-color-scheme
// fallback reads it. Install a writable stub; tests reassign it per case.
// Guarded so the same setup file also loads for node-environment tests
// (e.g. the auth/route suites), where `window` does not exist.
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

// jose (session-cookie signing) uses the WebCrypto `subtle` API. Node exposes
// it via globalThis.crypto.subtle, but jsdom installs a partial `crypto` that
// lacks a usable subtle. Backfill it from node:crypto's native webcrypto so the
// auth unit tests can run under jsdom; the Next.js server runtime already has
// the full implementation.
import { webcrypto } from "node:crypto";
if (typeof globalThis.crypto === "undefined" || !globalThis.crypto?.subtle) {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: webcrypto,
  });
}
