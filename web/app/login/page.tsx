"use client";

// Login page, ported from the static prototype public/login-v3.html into the
// React shell. Renders a centered card without the app chrome (AppShell skips
// its sidebar/topbar for /login). Submits credentials to /api/auth/login and,
// on success, redirects to the `next` query param (the page the visitor
// originally asked for, preserved by the auth redirect) or / by default.

import { Box, Button, TextField, Typography } from "@mui/material";
import { FormEvent, useState } from "react";

import { useI18n } from "@/lib/i18n";

/** Safe same-origin path from the `next` query param, else "/". */
function readNextPath(): string {
  const raw = new URLSearchParams(window.location.search).get("next");
  if (!raw) return "/";
  // Resolve against the current origin and keep only same-origin paths. The
  // backslash check stops encoded cross-origin redirects such as
  // `next=/%5Cevil.example` (browsers treat `\` as `/` on navigation).
  if (raw.includes("\\")) return "/";
  let url: URL;
  try {
    url = new URL(raw, window.location.origin);
  } catch {
    return "/";
  }
  if (url.origin !== window.location.origin) return "/";
  return url.pathname + url.search + url.hash;
}

export default function LoginPage() {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setSubmitError(null);

    const user = username.trim();
    const pass = password;
    if (!user) {
      setFieldError("auth.userRequired");
      return;
    }
    if (!pass) {
      setFieldError("auth.passRequired");
      return;
    }
    setFieldError(null);
    setBusy(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: user, password: pass }),
      });
      if (res.ok) {
        window.location.assign(readNextPath());
        return;
      }
      if (res.status === 401) {
        setSubmitError(t("auth.failed"));
      } else {
        setSubmitError(t("auth.failed"));
        // The backend reports configuration problems (e.g. missing htpasswd
        // Secret) with a generic message; surface it verbatim for operators.
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (body.error && res.status === 500) setSubmitError(body.error);
      }
    } catch {
      setSubmitError(t("auth.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Box
      sx={[
        { minHeight: "100vh" },
        { minHeight: "100dvh" },
        {
          display: "flex",
          flexDirection: "column",
          bgcolor: "var(--surface)",
        },
      ]}
    >
      {/* Top bar: brand + theme toggle */}
      <Box
        component="header"
        data-od-id="auth-top"
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          px: "28px",
          py: "20px",
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <Box
            sx={{
              width: 28,
              height: 28,
              borderRadius: "var(--radius)",
              bgcolor: "var(--fg)",
              color: "var(--bg)",
              display: "grid",
              placeItems: "center",
              flex: "none",
            }}
          >
            <Box component="svg" viewBox="0 0 24 24" width={16} height={16} fill="none" stroke="currentColor" strokeWidth={1.6}>
              <path d="M12 2.5 21 7.5v9l-9 5-9-5v-9l9-5Z" />
              <path d="M12 12 21 7.5M12 12v9.5M12 12 3 7.5" />
            </Box>
          </Box>
          <Box sx={{ fontWeight: 650, fontSize: 15, letterSpacing: "-0.01em" }}>
            CubeStack
            <Box component="span" sx={{ color: "var(--muted)", fontWeight: 400, ml: "6px" }}>
              {t("brand.sub")}
            </Box>
          </Box>
        </Box>
        {/* Reuse the shared theme toggle */}
        <ThemeToggleStandalone />
      </Box>

      <Box
        data-od-id="auth-stage"
        sx={{
          position: "relative",
          overflow: "hidden",
          flex: 1,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          px: "24px",
        }}
      >
        {/* Brand motif backdrop: isometric cube grid fading toward the edges, center kept clear (decorative only). */}
        <Box
          component="svg"
          aria-hidden="true"
          focusable={false}
          className="login-lattice"
          sx={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            color: "var(--border)",
            opacity: 0.8,
            pointerEvents: "none",
          }}
        >
          <defs>
            <pattern id="cube-pat" width="56" height="48" patternUnits="userSpaceOnUse">
              <path
                d="M28 2 52 16 28 30 4 16Z M4 16v16l24 14V30 M52 16v16L28 46V30"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
                strokeLinejoin="round"
              />
            </pattern>
            <radialGradient id="lattice-fade" cx="50%" cy="42%" r="72%">
              <stop offset="0%" stopColor="black" />
              <stop offset="52%" stopColor="black" />
              <stop offset="100%" stopColor="white" />
            </radialGradient>
            <mask id="lattice-mask">
              <rect width="100%" height="100%" fill="url(#lattice-fade)" />
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="url(#cube-pat)" mask="url(#lattice-mask)" />
        </Box>
        <Box
          data-od-id="login-card"
          component="form"
          onSubmit={onSubmit}
          noValidate
          sx={{
            width: "min(420px, 100%)",
            bgcolor: "var(--bg)",
            border: 1,
            borderColor: "var(--border)",
            borderRadius: "var(--radius)",
            boxShadow: "0 1px 2px color-mix(in oklch, var(--fg) 4%, transparent), 0 16px 40px -16px color-mix(in oklch, var(--fg) 10%, transparent)",
            px: { xs: "22px", sm: "32px" },
            py: { xs: "28px", sm: "36px" },
          }}
        >
          <Box sx={{ mb: "24px" }}>
            <Typography sx={{ fontSize: 24, fontWeight: 650, letterSpacing: "-0.02em", lineHeight: 1.2, color: "text.primary" }}>
              {t("auth.title")}
            </Typography>
            <Typography sx={{ mt: "8px", fontSize: 14, color: "var(--muted)" }}>
              {t("auth.sub")}
            </Typography>
          </Box>

          <TextField
            autoFocus
            label={t("auth.username")}
            variant="outlined"
            size="small"
            fullWidth
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            error={fieldError !== null}
            helperText={fieldError === "auth.userRequired" ? t("auth.userRequired") : ""}
            sx={{ mb: "16px" }}
            data-od-id="login-username"
          />

          <TextField
            label={t("auth.password")}
            variant="outlined"
            size="small"
            fullWidth
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            error={fieldError !== null}
            helperText={fieldError === "auth.passRequired" ? t("auth.passRequired") : ""}
            sx={{ mb: "22px" }}
            data-od-id="login-password"
          />

          {submitError ? (
            <Typography data-od-id="login-error" sx={{ mb: "16px", fontSize: 13, color: "#d4380d" }}>
              {submitError}
            </Typography>
          ) : null}

          <Button
            type="submit"
            variant="contained"
            fullWidth
            disabled={busy}
            data-od-id="login-submit"
            sx={{
              height: 44,
              textTransform: "none",
              fontWeight: 600,
              fontSize: 14.5,
              bgcolor: "var(--fg)",
              color: "var(--bg)",
              borderRadius: "var(--radius)",
              "&:hover": {
                bgcolor: "color-mix(in oklch, var(--fg) 86%, var(--bg))",
              },
            }}
          >
            {busy ? t("auth.loggingIn") : t("auth.login")}
          </Button>

          <Typography sx={{ mt: "22px", pt: "18px", borderTop: 1, borderColor: "var(--border)", fontSize: 13, color: "var(--muted)", textAlign: "center" }}>
            {t("auth.stageNote")}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}

// Small standalone theme toggle so the login page can keep dark/light switch
// without pulling in the full shell components. The dark flag lives in React
// state so the icon and label update as soon as the theme flips.
function ThemeToggleStandalone() {
  const [dark, setDark] = useState(
    () => typeof document !== "undefined" && document.documentElement.dataset.theme === "dark",
  );
  const label = dark ? "theme.toLight" : "theme.toDark";
  const { t } = useI18n();
  return (
    <Button
      aria-label={t(label)}
      title={t("theme.toggleTitle")}
      onClick={() => {
        const next = dark ? "light" : "dark";
        document.documentElement.dataset.theme = next;
        setDark(next === "dark");
        try {
          localStorage.setItem("cubestack-theme", next);
        } catch {
          // ignore
        }
      }}
      data-od-id="theme-toggle"
      sx={{
        minWidth: 32,
        width: 32,
        height: 32,
        px: 0,
        border: 1,
        borderColor: "var(--border)",
        borderRadius: "var(--radius)",
        color: "var(--fg)",
        "&:hover": { borderColor: "var(--fg)" },
      }}
    >
      {dark ? "☀" : "☾"}
    </Button>
  );
}