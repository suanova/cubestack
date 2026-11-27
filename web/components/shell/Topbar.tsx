"use client";

// Topbar: sticky blurred bar matching the prototype pages' `.topbar`
// (public/overview.html) — breadcrumb on the left; docs, theme toggle, language
// switcher and avatar on the right. The blurred background is the same
// color-mix() of --bg as the prototype, so it tracks the theme without a
// re-render hook.

import { Box, IconButton, Menu, MenuItem, Tooltip } from "@mui/material";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { DocsButton } from "@/components/shell/DocsButton";
import { LanguageSwitcher } from "@/components/shell/LanguageSwitcher";
import { ThemeToggle } from "@/components/perses/ThemeToggle";
import { apiFetch } from "@/lib/base-path";
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
  if (pathname === "/cubepilot" || pathname.startsWith("/cubepilot/")) return "nav.cubepilot";
  if (pathname === "/settings") return "nav.settings";
  return null;
}

export function Topbar() {
  const pathname = usePathname();
  const router = useRouter();
  const { t } = useI18n();
  const section = crumbKey(pathname);

  // The current user (from /api/auth/me) so the shell can show who is signed
  // in and offer the settings/sign-out menu. A 401 (no session) just hides the
  // badge. isAdmin gates the 设置 entry: only PORTAL_ADMIN_USERS may change
  // platform branding.
  const [user, setUser] = useState<string>("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [menuAnchor, setMenuAnchor] = useState<null | HTMLElement>(null);
  useEffect(() => {
    apiFetch("/api/auth/me")
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((body: { user?: string; isAdmin?: boolean }) => {
        setUser(body.user ?? "");
        setIsAdmin(body.isAdmin === true);
      })
      .catch(() => setUser(""));
  }, []);

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
          <DocsButton />
          <ThemeToggle />
          <LanguageSwitcher />
          {user ? (
            <>
              <Tooltip title={user} arrow>
                <IconButton
                  aria-label={user}
                  data-od-id="current-user"
                  onClick={(event) => setMenuAnchor(event.currentTarget)}
                  sx={{
                    width: 28,
                    height: 28,
                    padding: 0,
                    bgcolor: "text.primary",
                    color: "background.default",
                    "&:hover": { bgcolor: "text.primary" },
                  }}
                >
                  <Box component="span" sx={{ fontSize: 12, fontWeight: 600, lineHeight: 1, userSelect: "none" }}>
                    {user.charAt(0).toUpperCase()}
                  </Box>
                </IconButton>
              </Tooltip>
              <Menu
                anchorEl={menuAnchor}
                open={Boolean(menuAnchor)}
                onClose={() => setMenuAnchor(null)}
                anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
                transformOrigin={{ vertical: "top", horizontal: "right" }}
                slotProps={{ paper: { sx: { borderRadius: "var(--radius)", minWidth: 168 } } }}
              >
                <MenuItem
                  disabled
                  sx={{ fontSize: 13, py: "4px", "&.Mui-disabled": { opacity: 1, color: "text.secondary" } }}
                >
                  {user}
                </MenuItem>
                {isAdmin ? (
                  <MenuItem
                    data-od-id="settings-menu-item"
                    onClick={() => {
                      setMenuAnchor(null);
                      router.push("/settings");
                    }}
                    sx={{ fontSize: 13.5, py: "6px" }}
                  >
                    {t("nav.settings")}
                  </MenuItem>
                ) : null}
                <MenuItem
                  data-od-id="logout-button"
                  onClick={async () => {
                    setMenuAnchor(null);
                    try {
                      await apiFetch("/api/auth/logout", { method: "POST" });
                    } finally {
                      router.replace("/login");
                    }
                  }}
                  sx={{ fontSize: 13.5, py: "6px" }}
                >
                  {t("auth.logout")}
                </MenuItem>
              </Menu>
            </>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}
