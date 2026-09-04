"use client";

// Shared platform chrome for every portal page: the 232px sidebar + sticky
// topbar from the static prototypes (public/overview.html), plus the MUI
// ThemeProvider that pages previously built for themselves. Rendered once from
// the root layout; pages just provide content into the `main` slot.

import { Box, CssBaseline, ThemeProvider } from "@mui/material";
import { usePathname } from "next/navigation";
import { ReactNode, useMemo } from "react";

import { Sidebar } from "@/components/shell/Sidebar";
import { Topbar } from "@/components/shell/Topbar";
import { buildPlatformMuiTheme, usePlatformTheme } from "@/lib/perses/theme";

export function AppShell({ children }: { children: ReactNode }) {
  const mode = usePlatformTheme();
  const theme = useMemo(() => buildPlatformMuiTheme(mode), [mode]);
  const pathname = usePathname();

  // The login page has no app chrome: it renders standalone within the shared
  // layout (theme/locale bootstrap + MUI provider) but without sidebar/topbar.
  const bare = pathname === "/login";

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {bare ? (
        children
      ) : (
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "232px 1fr",
            minHeight: "100vh",
            bgcolor: "background.default",
            color: "text.primary",
          }}
        >
          <Sidebar />
          <Box sx={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
            <Topbar />
            <Box
              component="main"
              sx={{
                flexGrow: 1,
                minHeight: 0,
                display: "flex",
                flexDirection: "column",
                width: "100%",
              }}
            >
              {children}
            </Box>
          </Box>
        </Box>
      )}
    </ThemeProvider>
  );
}
