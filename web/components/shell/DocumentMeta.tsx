"use client";

// Next resolves the static `metadata` export on the server, where the
// client-side locale store isn't visible (and where it must stay locale-neutral
// so a non-zh-CN first load doesn't end up titled in Chinese). Re-stamp <title>
// and the description meta tag from the live locale after hydration, deriving a
// per-page title from the route so tabs, history and bookmarks can tell 推理服务
// from 平台总览. Renders nothing.

import { usePathname } from "next/navigation";
import { useEffect } from "react";

import { useI18n, type MessageKey } from "@/lib/i18n";

/** Map a route to the nav key that names that page (mirrors Topbar's crumb). */
function pageKey(pathname: string): MessageKey | null {
  if (pathname === "/") return "nav.overview";
  if (pathname.startsWith("/dashboards")) return "nav.monitoring";
  if (pathname === "/inference-services" || pathname.startsWith("/inference-services/")) return "nav.inference";
  if (pathname === "/dev-environments" || pathname.startsWith("/dev-environments/")) return "nav.devenv";
  if (pathname === "/cubepilot" || pathname.startsWith("/cubepilot/")) return "nav.cubepilot";
  return null;
}

export function DocumentMeta() {
  const { t } = useI18n();
  const pathname = usePathname();
  const appTitle = t("app.title");
  const description = t("app.description");
  const key = pageKey(pathname);
  const title = key ? `${t(key)} · ${appTitle}` : appTitle;

  useEffect(() => {
    document.title = title;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", description);
  }, [title, description]);

  return null;
}
