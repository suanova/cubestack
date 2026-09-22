"use client";

// Shared UI kit for the 智能助手 (CubePilot) panes: cards, pills, buttons,
// fields, switches and icons, styled after the static prototype
// (public/copilot.html) and the reference views (cubepilot web/src/views).
// Semantic hues come from the derived tokens in globals.css (the prototypes'
// palette); the other portal pages still carry their own hardcoded copies.
// Everything else derives from the platform CSS variables in globals.css.

import { Alert, Box, Snackbar, SxProps, Theme } from "@mui/material";
import {
  DetailedHTMLProps,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  Ref,
  TextareaHTMLAttributes,
  forwardRef,
  useCallback,
  useRef,
  useState,
} from "react";

/** Status hues. These are the tokens globals.css derives from --accent, so a
 *  change to the accent moves them too (the prototypes defined them the same
 *  way). Anything that needs a tint mixes them the way Pill does below. */
export const STATUS_OK = "var(--ok)";
export const STATUS_WARN = "var(--warn)";
export const STATUS_ERR = "var(--danger)";
export const VIOLET = "var(--violet)";

export const soft = (hex: string, pct = 13) => `color-mix(in oklch, ${hex} ${pct}%, transparent)`;

// ── icons (reference web/src, stroke style) ──────────────────────────────

function Svg({ children, size = 14, ...rest }: { children: ReactNode; size?: number; [k: string]: unknown }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const Icons = {
  plus: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  close: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M18 6L6 18M6 6l12 12" />
    </Svg>
  ),
  /** Expand: the corners of a box pushed outward. The floating chat's way to the
   *  full-page pane, which is the same conversation with more room. */
  expand: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </Svg>
  ),
  run: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M6 4l14 8-14 8z" />
    </Svg>
  ),
  export: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    </Svg>
  ),
  lock: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Svg>
  ),
  warn: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01" />
    </Svg>
  ),
  check: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M20 6L9 17l-5-5" />
    </Svg>
  ),
  search: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <circle cx="11" cy="11" r="8" />
      <path d="M21 21l-4.35-4.35" />
    </Svg>
  ),
  chat: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </Svg>
  ),
  send: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" />
    </Svg>
  ),
  tool: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M4 17l6-6-6-6M12 19h8" />
    </Svg>
  ),
  cube: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M12 2.5 21 7.5v9l-9 5-9-5v-9l9-5Z" />
      <path d="M12 12 21 7.5M12 12v9.5M12 12 3 7.5" />
    </Svg>
  ),
  spark: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <path d="M12 3l1.8 4.6L18.5 9l-4.7 1.4L12 15l-1.8-4.6L5.5 9l4.7-1.4L12 3Z" />
      <path d="M18.5 14.5l.9 2.3 2.1.7-2.1.7-.9 2.3-.9-2.3-2.1-.7 2.1-.7.9-2.3Z" />
    </Svg>
  ),
  tasks: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 3" />
    </Svg>
  ),
  agent: (p?: { size?: number }) => (
    <Svg {...(p ?? {})}>
      <rect x="8" y="8" width="8" height="8" rx="1.5" />
      <path d="M8 5V3M12 5V3M16 5V3M8 21v-2M12 21v-2M16 21v-2M3 8h2M3 12h2M3 16h2M19 8h2M19 12h2M19 16h2" />
    </Svg>
  ),
};

// ── primitives ───────────────────────────────────────────────────────────

// ...rest carries data-* hooks (e.g. data-od-id) through to the DOM node.
export function Card({
  children,
  sx,
  ...rest
}: { children: ReactNode; sx?: SxProps<Theme> } & HTMLAttributes<HTMLDivElement>) {
  return (
    <Box
      {...rest}
      sx={{
        bgcolor: "background.default",
        border: 1,
        borderColor: "divider",
        borderRadius: "var(--radius)",
        overflow: "hidden",
        ...sx,
      }}
    >
      {children}
    </Box>
  );
}

export function CardHead({
  title,
  hint,
  actions,
}: {
  title: ReactNode;
  hint?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "12px",
        px: "20px",
        py: "14px",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Box component="span" sx={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.005em" }}>
        {title}
      </Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: "12px", minWidth: 0 }}>
        {hint ? (
          <Box
            component="span"
            sx={{
              fontFamily: "var(--font-mono)",
              fontSize: 11,
              color: "text.secondary",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {hint}
          </Box>
        ) : null}
        {actions}
      </Box>
    </Box>
  );
}

type PillVariant = "ok" | "warn" | "danger" | "neutral" | "accent" | "violet";

const PILL_COLORS: Record<PillVariant, string> = {
  ok: STATUS_OK,
  warn: STATUS_WARN,
  danger: STATUS_ERR,
  neutral: "var(--muted)",
  accent: "var(--accent)",
  // The agent's own hue: the card that asks on its behalf is violet, so its
  // status chip is too (the approval card's is amber for the same reason).
  violet: "var(--violet)",
};

export function Pill({
  variant = "neutral",
  children,
  dot = false,
  pulse = false,
  sx,
  ...rest
}: {
  variant?: PillVariant;
  children: ReactNode;
  dot?: boolean;
  pulse?: boolean;
  sx?: SxProps<Theme>;
} & HTMLAttributes<HTMLSpanElement>) {
  const c = PILL_COLORS[variant];
  return (
    <Box
      {...rest}
      component="span"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: "6px",
        px: "9px",
        py: "2px",
        borderRadius: 999,
        fontSize: 12,
        whiteSpace: "nowrap",
        color: `color-mix(in oklch, ${c} 62%, var(--fg))`,
        bgcolor: soft(c, variant === "neutral" ? 9 : 13),
        border: `1px solid ${soft(c, 32)}`,
        flex: "none",
        ...sx,
      }}
    >
      {dot ? (
        <Box
          component="span"
          sx={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            bgcolor: c,
            flex: "none",
            ...(pulse ? { animation: "pend-pulse 1.6s ease-in-out infinite", "@keyframes pend-pulse": { "50%": { opacity: 0.35 } } } : {}),
          }}
        />
      ) : null}
      {children}
    </Box>
  );
}

type BtnVariant = "primary" | "secondary" | "ghost" | "ok";

export function Btn({
  variant = "secondary",
  small = false,
  disabled = false,
  onClick,
  children,
  title,
  sx,
  type = "button",
  ...rest
}: {
  variant?: BtnVariant;
  small?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  sx?: SxProps<Theme>;
  type?: "button" | "submit";
} & HTMLAttributes<HTMLButtonElement>) {
  // Plain literals (not SxProps) so the merged object below stays assignable
  // to Box's sx prop; the caller's sx is spread last and wins.
  const base = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "7px",
    borderRadius: "var(--radius)",
    border: 1,
    fontSize: small ? 12.5 : 13.5,
    fontWeight: 550,
    whiteSpace: "nowrap",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    padding: small ? "4px 10px" : "8px 16px",
    transition: "background .15s ease, border-color .15s ease, color .15s ease",
    "&:active:not([data-disabled])": { transform: "translateY(1px)" },
  };
  const byVariant = {
    primary: {
      bgcolor: "var(--accent)",
      color: "#fff",
      borderColor: "var(--accent)",
      "&:hover:not([data-disabled])": { bgcolor: "color-mix(in oklch, var(--accent) 82%, black)" },
    },
    secondary: {
      bgcolor: "background.default",
      color: "text.primary",
      borderColor: "divider",
      "&:hover:not([data-disabled])": { borderColor: "var(--fg)" },
    },
    // The affirmative answer, in the green the platform already speaks: the same
    // tint / border / text recipe the status pills use (ok / Ready / 已完成), a
    // step stronger than theirs because a button is a far larger area than a
    // 12px chip and the same 13% would leave the primary action looking like the
    // quietest thing on the card. A solid fill is the other end -- the accent's
    // own weight, which this card's two other buttons do not have either.
    ok: {
      bgcolor: "color-mix(in oklch, var(--ok) 22%, transparent)",
      color: "var(--ok-text)",
      borderColor: "color-mix(in oklch, var(--ok) 45%, transparent)",
      "&:hover:not([data-disabled])": { bgcolor: "color-mix(in oklch, var(--ok) 32%, transparent)" },
    },
    ghost: {
      bgcolor: "transparent",
      color: "var(--accent-strong)",
      borderColor: "transparent",
      px: "6px",
      "&:hover:not([data-disabled])": { textDecoration: "underline", textUnderlineOffset: 3 },
    },
  } as const;
  return (
    <Box
      {...rest}
      component="button"
      type={type}
      data-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={title}
      aria-disabled={disabled || undefined}
      sx={{ ...base, ...byVariant[variant], ...sx }}
    >
      {children}
    </Box>
  );
}

/** Shared style for the reference's `.input` (native elements, portal theme). */
export const inputSx: SxProps<Theme> = {
  width: "100%",
  boxSizing: "border-box",
  border: 1,
  borderColor: "divider",
  borderRadius: "var(--radius)",
  bgcolor: "background.default",
  color: "text.primary",
  font: "inherit",
  fontSize: 13.5,
  padding: "8px 12px",
  outline: "none",
  "&:focus": { borderColor: "var(--accent)", boxShadow: "0 0 0 3px var(--accent-soft)" },
  "&[disabled]": { opacity: 0.55 },
};

export const monoSx: SxProps<Theme> = { fontFamily: "var(--font-mono)" };

/** Native text input styled with inputSx; Box forwards the native props. */
export const CpInput = forwardRef<
  HTMLInputElement,
  { sx?: SxProps<Theme> } & Omit<DetailedHTMLProps<InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>, "ref">
>(function CpInput({ sx, ...rest }, ref) {
  return <Box component="input" ref={ref as unknown as Ref<unknown>} sx={({ ...inputSx, ...(sx ?? {}) } as SxProps<Theme>)} {...rest} />;
});

/** Native textarea styled with inputSx. */
export const CpTextArea = forwardRef<
  HTMLTextAreaElement,
  { sx?: SxProps<Theme> } & Omit<DetailedHTMLProps<TextareaHTMLAttributes<HTMLTextAreaElement>, HTMLTextAreaElement>, "ref">
>(function CpTextArea({ sx, ...rest }, ref) {
  return (
    <Box
      component="textarea"
      ref={ref as unknown as Ref<unknown>}
      sx={({ ...inputSx, resize: "vertical", ...(sx ?? {}) } as SxProps<Theme>)}
      {...rest}
    />
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  sx,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  sx?: SxProps<Theme>;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: "6px", ...sx }}>
      {label ? (
        <Box component="label" sx={{ fontSize: 12.5, color: "text.secondary", fontWeight: 550 }}>
          {label}
        </Box>
      ) : null}
      {children}
      {hint ? <Box sx={{ fontSize: 12, color: "text.secondary" }}>{hint}</Box> : null}
      {error ? <Box sx={{ fontSize: 12, color: STATUS_ERR }}>{error}</Box> : null}
    </Box>
  );
}

export function Spinner({ size = 13, color }: { size?: number; color?: string }) {
  return (
    <Box
      component="span"
      sx={{
        display: "inline-block",
        width: size,
        height: size,
        border: `2px solid ${soft("var(--muted)", 35)}`,
        borderTopColor: color ?? "var(--accent)",
        borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
        flex: "none",
        "@keyframes spin": { to: { transform: "rotate(360deg)" } },
      }}
    />
  );
}

// ── toast ────────────────────────────────────────────────────────────────

/** Minimal per-pane toast (the reference uses a global store; panes here are
 *  independent client components, so each owns its snackbar). */
export function useToast() {
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string, kind: "success" | "error" = "success") => {
    setToast({ msg, kind });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const view = (
    <Snackbar
      open={!!toast}
      autoHideDuration={3200}
      onClose={() => setToast(null)}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
    >
      <Alert
        severity={toast?.kind === "error" ? "error" : "success"}
        variant="filled"
        sx={{ borderRadius: "var(--radius)", fontSize: 13 }}
      >
        {toast?.msg}
      </Alert>
    </Snackbar>
  );

  return { showToast, toastView: view };
}
