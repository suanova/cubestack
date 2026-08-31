"use client";

// Next resolves the static `metadata` export on the server, where the
// client-side locale store isn't visible. Re-stamp <title> and the description
// meta tag from the live locale so the document metadata follows the language
// switcher. Renders nothing.

import { useEffect } from "react";

import { useI18n } from "@/lib/i18n";

export function DocumentMeta() {
  const { t } = useI18n();
  const title = t("app.title");
  const description = t("app.description");

  useEffect(() => {
    document.title = title;
    const meta = document.querySelector('meta[name="description"]');
    if (meta) meta.setAttribute("content", description);
  }, [title, description]);

  return null;
}
