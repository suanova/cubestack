"use client";

// Docs button: opens the online documentation (BASE_PATH/docs) in a dialog over
// the current page, so reading help does not lose the user's place. Same chrome
// as the theme toggle and language switcher.

import { Dialog, DialogContent, DialogTitle, IconButton } from "@mui/material";
import { useState } from "react";

import { NavIcon } from "@/components/shell/NavIcons";
import { useBrandName } from "@/components/shell/brandingStore";
import { withBasePath } from "@/lib/base-path";
import { useI18n } from "@/lib/i18n";

export function DocsButton() {
  const { t } = useI18n();
  const brand = useBrandName();
  const docsTitle = t("docs.title", { brand });
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        data-od-id="docs-button"
        aria-label={t("docs.open")}
        title={t("docs.open")}
        onClick={() => setOpen(true)}
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
        <NavIcon name="help" size={14} />
      </IconButton>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        maxWidth={false}
        data-od-id="docs-dialog"
        slotProps={{ paper: { sx: { width: "min(1100px, 92vw)", height: "85vh" } } }}
      >
        <DialogTitle
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 15,
            fontWeight: 650,
            py: "10px",
            pl: "20px",
          }}
        >
          {docsTitle}
          <IconButton aria-label={t("docs.close")} title={t("docs.close")} onClick={() => setOpen(false)} size="small">
            <NavIcon name="close" size={16} />
          </IconButton>
        </DialogTitle>
        <DialogContent sx={{ p: 0, overflow: "hidden" }}>
          {/* Mount the frame only while open: no docs request until the user asks. */}
          {open ? (
            <iframe
              src={withBasePath("/docs")}
              title={docsTitle}
              style={{ display: "block", width: "100%", height: "100%", border: 0 }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
