"use client";

// 平台设置 — the entry is the avatar menu in the topbar (shown to admins only).
// Branding is cluster-wide: it lives in the branding ConfigMap and the sidebar
// and login page render it for everyone. The logo, brand name and subtitle can
// each be customized; restoring the default clears all three.

import { Box, Button, TextField, Typography } from "@mui/material";
import { ChangeEvent, useEffect, useState } from "react";

import { NavIcon } from "@/components/shell/NavIcons";
import { setBranding } from "@/components/shell/brandingStore";
import { apiFetch } from "@/lib/base-path";
import { useI18n } from "@/lib/i18n";
import {
  LOGO_ACCEPT,
  LOGO_MIME_TYPES,
  MAX_LOGO_BYTES,
  MAX_LOGO_EDGE,
  MAX_UPLOAD_BYTES,
  fitWithin,
  isValidLogo,
  logoBytes,
} from "@/lib/settings/logo";

type BrandingResponse = {
  logo?: unknown;
  title?: unknown;
  subtitle?: unknown;
  canEdit?: unknown;
};

type BrandingPayload = { logo: string | null; title: string | null; subtitle: string | null };

const TEXT_MAX = 64;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

/** SVG scales without rasterising, and a GIF may be animated. */
const KEEP_ORIGINAL = new Set(["image/svg+xml", "image/gif"]);

/**
 * The data URL to store for a picked file. Large images are downscaled so a
 * phone photo does not end up as a multi-megabyte brand; a logo is never shown
 * wider than the sidebar, so 512px on the longest edge is plenty. Decoding is
 * best-effort: when the browser cannot (or will not) decode the file, the
 * original is returned and the caller's size check decides.
 */
async function prepareLogo(file: File): Promise<string> {
  const original = await readFile(file);
  if (KEEP_ORIGINAL.has(file.type)) return original;

  try {
    const bitmap = await createImageBitmap(file);
    try {
      const { width, height } = fitWithin(bitmap.width, bitmap.height);
      if (width === bitmap.width && height === bitmap.height && file.size <= MAX_LOGO_BYTES) {
        return original;
      }

      const type = file.type === "image/jpeg" ? "image/jpeg" : file.type === "image/webp" ? "image/webp" : "image/png";
      let last = original;
      // Retry a little smaller if a photo still exceeds the stored size cap.
      for (const edge of [MAX_LOGO_EDGE, MAX_LOGO_EDGE / 2, MAX_LOGO_EDGE / 4]) {
        const size = fitWithin(bitmap.width, bitmap.height, edge);
        const canvas = document.createElement("canvas");
        canvas.width = size.width;
        canvas.height = size.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) return original;
        ctx.drawImage(bitmap, 0, 0, size.width, size.height);
        last = canvas.toDataURL(type, 0.9);
        if (isValidLogo(last)) return last;
      }
      return last;
    } finally {
      bitmap.close?.();
    }
  } catch {
    return original;
  }
}

export default function SettingsPage() {
  const { t } = useI18n();
  const [logo, setLogo] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  // What the cluster holds, so Save can tell whether there is anything to do.
  const [savedTitle, setSavedTitle] = useState("");
  const [savedSubtitle, setSavedSubtitle] = useState("");
  // The image picked but not saved yet.
  const [draft, setDraft] = useState<string | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(true);
  // Kept as a flag (not a translated string) so the effect does not depend on
  // the per-render `t` and refetch on every render.
  const [loadFailed, setLoadFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/settings/branding")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then((body: BrandingResponse) => {
        if (cancelled) return;
        const nextTitle = typeof body.title === "string" ? body.title : "";
        const nextSubtitle = typeof body.subtitle === "string" ? body.subtitle : "";
        setLogo(typeof body.logo === "string" ? body.logo : null);
        setTitle(nextTitle);
        setSubtitle(nextSubtitle);
        setSavedTitle(nextTitle);
        setSavedSubtitle(nextSubtitle);
        setCanEdit(body.canEdit === true);
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Let the same file be picked again after an error.
    event.target.value = "";
    if (!file) return;
    setMessage(null);
    setError(null);

    if (!LOGO_MIME_TYPES.includes(file.type as (typeof LOGO_MIME_TYPES)[number])) {
      setError(t("settings.logo.invalidType"));
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(t("settings.logo.uploadTooLarge"));
      return;
    }
    try {
      const dataUrl = await prepareLogo(file);
      if (!isValidLogo(dataUrl)) {
        setError(logoBytes(dataUrl) > MAX_LOGO_BYTES ? t("settings.logo.tooLarge") : t("settings.logo.invalidType"));
        return;
      }
      setDraft(dataUrl);
    } catch {
      setError(t("settings.logo.invalidType"));
    }
  }

  async function save(next: BrandingPayload) {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const res = await apiFetch("/api/settings/branding", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next),
      });
      const body = (await res.json().catch(() => ({}))) as BrandingResponse & { error?: string };
      if (!res.ok) {
        if (res.status === 403) setError(t("settings.logo.forbidden"));
        else if (body.error === "brandingInvalid") setError(t("settings.text.invalid"));
        else setError(t("settings.logo.saveError"));
        return;
      }

      const nextLogo = typeof body.logo === "string" ? body.logo : null;
      const nextTitle = typeof body.title === "string" ? body.title : "";
      const nextSubtitle = typeof body.subtitle === "string" ? body.subtitle : "";
      setLogo(nextLogo);
      setTitle(nextTitle);
      setSubtitle(nextSubtitle);
      setSavedTitle(nextTitle);
      setSavedSubtitle(nextSubtitle);
      setDraft(null);
      setBranding({ logo: nextLogo, title: nextTitle || null, subtitle: nextSubtitle || null });
      setMessage(t("settings.logo.saved"));
    } catch {
      setError(t("settings.logo.saveError"));
    } finally {
      setSaving(false);
    }
  }

  const preview = draft ?? logo;
  const dirty = draft !== null || title !== savedTitle || subtitle !== savedSubtitle;
  const hasBranding = logo !== null || savedTitle !== "" || savedSubtitle !== "";

  return (
    <Box sx={{ p: "26px 28px 64px", width: "100%", mx: "auto" }}>
      <Box data-od-id="page-head" sx={{ mb: "22px" }}>
        <Typography sx={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.015em", color: "text.primary" }}>
          {t("nav.settings")}
        </Typography>
        <Typography sx={{ color: "text.secondary", fontSize: 13, mt: "5px" }}>{t("settings.sub")}</Typography>
      </Box>

      <Box
        data-od-id="settings-branding"
        sx={{
          maxWidth: 640,
          border: 1,
          borderColor: "divider",
          borderRadius: "var(--radius)",
          bgcolor: "background.paper",
          p: { xs: "18px", sm: "24px" },
        }}
      >
        <Typography sx={{ fontSize: 15, fontWeight: 600, color: "text.primary" }}>
          {t("settings.logo.title")}
        </Typography>
        <Typography sx={{ color: "text.secondary", fontSize: 13, mt: "5px" }}>
          {t("settings.logo.hint")}
        </Typography>

        {/* Logo is one thing: an image with its upload control beside it. */}
        <Box sx={{ mt: "18px", display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
          <Box
            data-od-id="logo-preview"
            sx={{
              // With an image the tile shrinks to the rendered logo (capped
              // here) so the whole logo is visible instead of sitting inside a
              // fixed box; with no image it stays a stable 140x64 placeholder.
              ...(preview
                ? { width: "auto", height: "auto", maxWidth: 160, maxHeight: 64 }
                : { width: 140, height: 64 }),
              flex: "none",
              boxSizing: "border-box",
              p: "6px",
              display: "grid",
              placeItems: "center",
              border: 1,
              borderColor: "divider",
              borderRadius: "var(--radius)",
              bgcolor: "var(--surface)",
              overflow: "hidden",
            }}
          >
            {preview ? (
              <Box
                component="img"
                src={preview}
                alt={t("settings.logo.alt")}
                sx={{
                  display: "block",
                  width: "auto",
                  height: "auto",
                  maxWidth: 148,
                  maxHeight: 52,
                  objectFit: "contain",
                }}
              />
            ) : (
              <Box sx={{ color: "text.secondary" }}>
                <NavIcon name="brand" size={28} />
              </Box>
            )}
          </Box>
          {canEdit ? (
            <Button
              component="label"
              variant="outlined"
              disabled={saving}
              sx={{ textTransform: "none", fontSize: 13, borderColor: "divider", color: "text.primary" }}
            >
              {t("settings.logo.choose")}
              <Box
                component="input"
                type="file"
                accept={LOGO_ACCEPT}
                onChange={onPickFile}
                data-od-id="logo-file"
                sx={{ display: "none" }}
              />
            </Button>
          ) : null}
        </Box>

        {!loading && !canEdit && !loadFailed ? (
          <Typography data-od-id="settings-readonly" sx={{ mt: "16px", fontSize: 13, color: "text.secondary" }}>
            {t("settings.logo.readOnly")}
          </Typography>
        ) : null}

        {canEdit ? (
          <>
            <Box sx={{ mt: "18px", display: "grid", gap: "12px", maxWidth: 420 }}>
              <TextField
                size="small"
                label={t("settings.text.title")}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                disabled={saving}
                slotProps={{ htmlInput: { maxLength: TEXT_MAX } }}
                data-od-id="brand-title"
              />
              <TextField
                size="small"
                label={t("settings.text.subtitle")}
                value={subtitle}
                onChange={(event) => setSubtitle(event.target.value)}
                disabled={saving}
                slotProps={{ htmlInput: { maxLength: TEXT_MAX } }}
                data-od-id="brand-subtitle"
              />
            </Box>

            <Box sx={{ mt: "18px", display: "flex", flexWrap: "wrap", gap: "10px" }}>
              <Button
                variant="contained"
                disableElevation
                disabled={!dirty || saving}
                onClick={() =>
                  save({
                    logo: draft ?? logo,
                    title: title.trim() || null,
                    subtitle: subtitle.trim() || null,
                  })
                }
                data-od-id="logo-save"
                sx={{ textTransform: "none", fontSize: 13, fontWeight: 550, bgcolor: "var(--fg)", color: "var(--bg)" }}
              >
                {saving ? t("settings.logo.saving") : t("settings.logo.save")}
              </Button>
              <Button
                variant="text"
                disabled={!hasBranding || saving}
                onClick={() => save({ logo: null, title: null, subtitle: null })}
                data-od-id="logo-reset"
                sx={{ textTransform: "none", fontSize: 13, color: "text.secondary" }}
              >
                {t("settings.logo.reset")}
              </Button>
            </Box>
          </>
        ) : null}

        {dirty && canEdit ? (
          <Typography sx={{ mt: "8px", fontSize: 12.5, color: "var(--muted)" }}>{t("settings.logo.pending")}</Typography>
        ) : null}
        {message ? (
          <Typography data-od-id="settings-message" sx={{ mt: "14px", fontSize: 13, color: "#27c37b" }}>
            {message}
          </Typography>
        ) : null}
        {(error ?? loadFailed) ? (
          <Typography data-od-id="settings-error" sx={{ mt: "14px", fontSize: 13, color: "#d4380d" }}>
            {error ?? t("settings.logo.loadError")}
          </Typography>
        ) : null}
      </Box>
    </Box>
  );
}
