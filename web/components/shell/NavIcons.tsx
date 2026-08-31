"use client";

// Inline SVG icon set lifted from the static prototype pages (public/*.html),
// plus the two the React shell adds: "activity" for 监控中心 and "globe" for the
// language switcher. All are 24x24 strokes drawn at 1.6px to match the
// prototype's nav icons.

import type { CSSProperties, ReactNode } from "react";

export type IconName =
  | "brand"
  | "grid"
  | "activity"
  | "server"
  | "terminal"
  | "code"
  | "spark"
  | "globe";

const ICONS: Record<IconName, ReactNode> = {
  brand: (
    <>
      <path d="M12 2.5 21 7.5v9l-9 5-9-5v-9l9-5Z" />
      <path d="M12 12 21 7.5M12 12v9.5M12 12 3 7.5" />
    </>
  ),
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  activity: <path d="M3 12h4l2.5-7 4 14 2.5-7h5" />,
  server: (
    <>
      <rect x="3.5" y="4.5" width="17" height="6.5" rx="1.5" />
      <rect x="3.5" y="13" width="17" height="6.5" rx="1.5" />
      <path d="M7 7.75h.01M7 16.25h.01M11 7.75h3M11 16.25h3" />
    </>
  ),
  terminal: (
    <>
      <path d="M4 5.5h16v11H4z" />
      <path d="M8 20.5h8M9 9.5l2.5 2.5L9 14.5M13.5 14.5H16" />
    </>
  ),
  code: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </>
  ),
  spark: (
    <>
      <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3Z" />
      <path d="M18.5 14.5l.9 2.3 2.1.7-2.1.7-.9 2.3-.9-2.3-2.1-.7 2.1-.7.9-2.3Z" />
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3Z" />
    </>
  ),
};

/** Render one of the shell's inline icons at the given pixel size. */
export function NavIcon({
  name,
  size = 15,
  style,
}: {
  name: IconName;
  size?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ width: size, height: size, flex: "none", ...style }}
    >
      {ICONS[name]}
    </svg>
  );
}
