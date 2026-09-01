"use client";

// Injects the platform bootstrap script (theme / locale stamping) into <head>
// during SSR instead of rendering a <script> in the body. A raw <script> in a
// React-rendered tree triggers React's "script tags are never executed when
// rendering on the client" warning on hydration; injected via
// useServerInsertedHTML it is never part of the client tree, and being in
// <head> it runs before the body is parsed — earlier than the old body
// placement, which is what the theme bootstrap wants.

import { useServerInsertedHTML } from "next/navigation";

export function PlatformInitScript({ script }: { script: string }) {
  useServerInsertedHTML(() => (
    <script dangerouslySetInnerHTML={{ __html: script }} />
  ));
  return null;
}
