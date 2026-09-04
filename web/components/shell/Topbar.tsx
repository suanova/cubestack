"use client";

// Topbar: sticky blurred bar matching the prototype pages' `.topbar`
// (public/overview.html) — breadcrumb on the left; theme toggle, language
// switcher and avatar on the right. The blurred background is the same
// color-mix() of --bg as the prototype, so it tracks the theme without a
// re-render hook.

import { Box } from "@mui/material";
import { usePathname } from "next/navigation";

import { LanguageSwitcher } from "@/components/shell/LanguageSwitcher";
import { ThemeToggle } from "@/components/perses/ThemeToggle";
import { MessageKey, useI18n } from "@/lib/i18n";

// Every page the React shell currently serves. The perses dashboards and their
// list both read as 监控中心.
function crumbKey(pathname: string): MessageKey | null {
  if (pathname === "/") return "nav.overview";
  if (pathname.startsWith("/dashboards")) return "nav.monitoring";
  // Match the exact-or-slash-prefixed rule used by lib/nav.ts isActive, so nested
  // service routes (e.g. /inference-services/svc-a) still show the breadcrumb.
  if (pathname === "/inference-services" || pathname.startsWith("/inference-services/")) return "nav.inference";
  if (pathname === "/dev-environments" || pathname.startsWith("/dev-environments/")) return "nav.devenv";
  return null;
}

export function Topbar() {
  const pathname = usePathname();
  const { t } = useI18n();
  const section = crumbKey(pathname);

  return (
    <Box
      component="header"
      data-od-id="topnav"
      sx={{
        position: "sticky",
        top: 0,
        zIndex: 20,
        background: "color-mix(in oklch, var(--bg) 88%, transparent)",
        backdropFilter: "blur(10px)",
        borderBottom: 1,
        borderColor: "divider",
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
          padding: "11px 28px",
        }}
      >
        <Box sx={{ fontSize: 13, color: "text.secondary" }}>
          {t("crumb.portal")}
          {" / "}
          {section ? (
            <Box component="b" sx={{ color: "text.primary", fontWeight: 600 }}>
              {t(section)}
            </Box>
          ) : null}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <ThemeToggle />
          <LanguageSwitcher />
          <Box
            component="span"
            sx={{
              width: 28,
              height: 28,
              borderRadius: "50%",
              bgcolor: "text.primary",
              color: "background.default",
              display: "grid",
              placeItems: "center",
              fontSize: 12,
              fontWeight: 600,
            }}
          >
            张
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
