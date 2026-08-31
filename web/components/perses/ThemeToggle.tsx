"use client";

import { IconButton } from "@mui/material";

import { useI18n } from "@/lib/i18n";
import { togglePlatformTheme, usePlatformTheme } from "@/lib/perses/theme";

// Sun/moon icons matching the static prototype pages' theme toggle.
function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

/** Theme toggle styled like the static prototype pages' `.theme-tog`. */
export function ThemeToggle() {
  const mode = usePlatformTheme();
  const { t } = useI18n();
  return (
    <IconButton
      data-od-id="theme-toggle"
      aria-label={mode === "dark" ? t("theme.toLight") : t("theme.toDark")}
      title={t("theme.toggleTitle")}
      onClick={togglePlatformTheme}
      sx={{
        width: 28,
        height: 28,
        padding: 0,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        color: "text.primary",
        bgcolor: "background.paper",
        "&:hover": { borderColor: "text.primary", bgcolor: "background.paper" },
        "& svg": { width: 14, height: 14 },
      }}
    >
      {mode === "dark" ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  );
}
