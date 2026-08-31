"use client";

// Language switcher: globe button in the topbar (same chrome as the theme
// toggle) + a menu of the three locales, self-named in their own language.
// Switching persists to localStorage["cubestack-locale"] and flips
// <html data-locale>/<html lang> via setPlatformLocale.

import { IconButton, Menu, MenuItem } from "@mui/material";
import { useState } from "react";

import { NavIcon } from "@/components/shell/NavIcons";
import { LOCALES, Locale, useI18n } from "@/lib/i18n";

const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
};

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n();
  const [anchor, setAnchor] = useState<null | HTMLElement>(null);
  const open = Boolean(anchor);

  return (
    <>
      <IconButton
        aria-label={t("lang.switch")}
        title={t("lang.switch")}
        onClick={(event) => setAnchor(event.currentTarget)}
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
        }}
      >
        <NavIcon name="globe" size={14} />
      </IconButton>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { borderRadius: "var(--radius)", minWidth: 132 } } }}
      >
        {LOCALES.map((l) => (
          <MenuItem
            key={l}
            selected={l === locale}
            onClick={() => {
              setLocale(l);
              setAnchor(null);
            }}
            sx={{ fontSize: 13.5, py: "6px" }}
          >
            {LOCALE_LABELS[l]}
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}
