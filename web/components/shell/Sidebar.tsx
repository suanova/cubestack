"use client";

// Sidebar: brand block + nav tree, matching the static prototype pages' `.side`
// (public/overview.html). The nav lists the platform modules; 监控中心 is a real
// link to /dashboards. Modules without a page yet render as dimmed placeholders
// — no link to the prototype's static .html pages. Each item carries a
// data-od-id hook for the shell's test tooling.

import { Box, SxProps, Theme, Typography } from "@mui/material";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { MouseEvent as ReactMouseEvent } from "react";

import { IconName, NavIcon } from "@/components/shell/NavIcons";
import { offerHandoffFromFloatingChat } from "@/components/cubepilot/agentHandoff";
import { getTabSnapshot, setStoredTab } from "@/components/cubepilot/tabStore";
import { withViewTransition } from "@/components/cubepilot/viewTransition";
import { MessageKey, useI18n } from "@/lib/i18n";
import { isActive } from "@/lib/nav";

interface NavItem {
  key: MessageKey;
  /** Real Next route; absent for placeholder modules without a page yet. */
  href?: string;
  icon: IconName;
  /** Test hook (data-od-id), consistent with side-nav/topnav/theme-toggle. */
  dataOdId: string;
}

const LINK_ITEMS: NavItem[] = [
  { key: "nav.overview", href: "/", icon: "grid", dataOdId: "nav-overview" },
  {
    key: "nav.monitoring",
    href: "/dashboards",
    icon: "activity",
    dataOdId: "nav-monitoring",
  },
  { key: "nav.inference", href: "/inference-services", icon: "server", dataOdId: "nav-inference" },
  { key: "nav.devenv", href: "/dev-environments", icon: "code", dataOdId: "nav-devenv" },
  { key: "nav.cubepilot", href: "/cubepilot", icon: "spark", dataOdId: "nav-copilot" },
];

function NavLink({
  item,
  pathname,
  label,
}: {
  item: NavItem;
  pathname: string;
  label: string;
}) {
  const active = item.href !== undefined && isActive(item.href, pathname);
  const router = useRouter();
  const sx: SxProps<Theme> = {
    display: "flex",
    alignItems: "center",
    gap: "9px",
    padding: "8px 10px",
    borderRadius: "var(--radius)",
    fontSize: 13.5,
    color: "text.secondary",
    ...(active
      ? {
          bgcolor: "var(--accent-soft)",
          color: "var(--accent-strong)",
          fontWeight: 550,
        }
      : {}),
  };
  const content = (
    <>
      <NavIcon name={item.icon} />
      <Box component="span" sx={{ lineHeight: 1.4 }}>
        {label}
      </Box>
    </>
  );
  if (item.href === undefined) {
    // Placeholder module with no page yet: show the label, link to nothing.
    return (
      <Box component="span" data-od-id={item.dataOdId} sx={{ ...sx, opacity: 0.65 }}>
        {content}
      </Box>
    );
  }
  // The two navigations that ARE a conversation changing size: entering the
  // assistant's chat page, and leaving it while its agent pane is on screen. Both go
  // through a view transition (the panel thread growing into the pane, the pane
  // collapsing back into the launcher) and the entry also hands over whatever the
  // floating panel is showing. Every other link navigates as it always did.
  const entersChat = item.href === "/cubepilot";
  const leavesChatPane = pathname === "/cubepilot" && getTabSnapshot() === "chat";
  const onClick =
    entersChat || leavesChatPane
      ? (event: ReactMouseEvent<HTMLAnchorElement>) => {
          // Anything but a plain left click is the browser's (new tab, new
          // window, download): those must keep working, un-transitioned.
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
          event.preventDefault();
          if (entersChat) {
            // The module opens on whichever tab was last used, and the reader
            // asked for the assistant: landing on 自动化任务 with the thread
            // handed over behind it would answer a different request.
            setStoredTab("chat");
            offerHandoffFromFloatingChat();
          }
          withViewTransition(
            () => router.push(item.href as string),
            entersChat
              ? () => !!document.querySelector('[data-od-id="pane-chat"]')
              : () => !!document.querySelector('[data-od-id="fchat-fab"]'),
          );
        }
      : undefined;
  return (
    <Box
      component={Link}
      href={item.href}
      data-od-id={item.dataOdId}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      sx={{
        ...sx,
        textDecoration: "none",
        "&:hover": { bgcolor: "var(--surface)", color: "text.primary" },
      }}
    >
      {content}
    </Box>
  );
}

export function Sidebar() {
  const pathname = usePathname();
  const { t } = useI18n();

  const sectionLabelSx: SxProps<Theme> = {
    margin: 0,
    fontFamily: "var(--font-mono)",
    fontSize: 10.5,
    letterSpacing: "0.09em",
    textTransform: "uppercase",
    color: "text.secondary",
    padding: "0 10px 6px",
  };

  return (
    <Box
      component="aside"
      data-od-id="side-nav"
      sx={{
        borderRight: 1,
        borderColor: "divider",
        padding: "18px 14px",
        display: "flex",
        flexDirection: "column",
        gap: "26px",
        position: "sticky",
        top: 0,
        height: "100vh",
        overflowY: "auto",
        bgcolor: "background.default",
      }}
    >
      <Box
        component={Link}
        href="/"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          padding: "2px 8px",
          textDecoration: "none",
          color: "text.primary",
        }}
      >
        <Box
          sx={{
            width: 28,
            height: 28,
            borderRadius: "var(--radius)",
            bgcolor: "text.primary",
            color: "background.default",
            display: "grid",
            placeItems: "center",
            flex: "none",
          }}
        >
          <NavIcon name="brand" size={16} />
        </Box>
        <Box
          component="span"
          sx={{
            fontWeight: 650,
            fontSize: 14.5,
            letterSpacing: "-0.01em",
            lineHeight: 1.2,
          }}
        >
          CubeStack
          <Box
            component="small"
            sx={{
              display: "block",
              color: "text.secondary",
              fontWeight: 400,
              fontSize: 11,
            }}
          >
            {t("brand.sub")}
          </Box>
        </Box>
      </Box>

      <Box
        component="nav"
        aria-label={t("nav.aria")}
        sx={{ display: "flex", flexDirection: "column", gap: "2px" }}
      >
        <Typography sx={sectionLabelSx}>{t("nav.section.portal")}</Typography>
        {LINK_ITEMS.map((item) => (
          <NavLink
            key={item.key}
            item={item}
            pathname={pathname}
            label={t(item.key)}
          />
        ))}
      </Box>
    </Box>
  );
}
