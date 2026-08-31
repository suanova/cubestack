"use client";

// Overview placeholder. The prototype landing (public/overview.html) is no
// longer linked from the portal, so the root route renders an empty page until
// the real overview ships.

import { Box, Typography } from "@mui/material";

import { useI18n } from "@/lib/i18n";

export default function Home() {
  const { t } = useI18n();
  return (
    <Box sx={{ p: 3, maxWidth: 1240, mx: "auto", width: "100%" }}>
      <Typography
        sx={{
          fontSize: 22,
          fontWeight: 650,
          letterSpacing: "-0.015em",
          lineHeight: 1.2,
          color: "text.primary",
        }}
      >
        {t("nav.overview")}
      </Typography>
    </Box>
  );
}
