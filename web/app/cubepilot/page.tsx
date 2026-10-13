"use client";

// 智能助手 (CubePilot) — three-tab portal page: 聊天 / 自动化任务 / 配置,
// rebuilt from the reference web app (github.com/suanova/cubepilot web/src)
// against the portal's /api/cubepilot/* demo routes. The panes stay mounted
// across tab switches (their fetch/state is preserved), like the prototype's
// hidden pane divs in public/copilot.html. The chat pane is the unified
// conversation surface for inference models and the CubePilot agent
// (public/chat.html).

import { Box, Typography } from "@mui/material";
import { useSyncExternalStore, useState } from "react";

import { ChatPane } from "@/components/cubepilot/ChatPane";
import { ConfigPane } from "@/components/cubepilot/ConfigPane";
import { TasksPane } from "@/components/cubepilot/TasksPane";
import {
  CUBEPILOT_TABS,
  getServerTabSnapshot,
  getTabSnapshot,
  setStoredTab,
  subscribeTab,
  type CubepilotTab,
} from "@/components/cubepilot/tabStore";
import { useI18n } from "@/lib/i18n";

export default function CubepilotPage() {
  const { t } = useI18n();
  const tab = useSyncExternalStore(subscribeTab, getTabSnapshot, getServerTabSnapshot);
  // The room's height is the reader's call: expanded, it is the page — the head
  // and the tab row fold away and the conversation takes the rows they had. The
  // flag only ever applies to the chat tab, so a selection that lands elsewhere
  // (the agent card's own way into 配置) still finds that tab's rows in place.
  const [roomExpanded, setRoomExpanded] = useState(false);
  const headless = tab === "chat" && roomExpanded;

  const tabItems: { id: CubepilotTab; label: string }[] = CUBEPILOT_TABS.map((id) => ({
    id,
    label: t(`cubepilot.tab.${id}`),
  }));

  return (
    <Box
      sx={{
        p: "26px 28px 64px",
        // The chat tab fills to the window bottom (its floating composer is
        // pinned to the viewport's bottom edge), so no page bottom padding.
        paddingBottom: tab === "chat" ? 0 : "64px",
        // …and it takes the height that is actually left, as a flex column: the
        // head is as tall as its text needs (a translated subtitle can wrap
        // where another does not), and the conversation absorbs the difference
        // instead of being pushed off the bottom edge. 77px is the app chrome
        // above this page -- the sticky topbar plus this box's top padding.
        ...(tab === "chat"
          ? {
              height: "calc(100dvh - 77px)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              // Narrow: the card goes back to its own height and the page
              // scrolls, which is what this layout has always done.
              "@media (max-width: 1180px)": { height: "auto", display: "block" },
            }
          : {}),
        mx: "auto",
        width: "100%",
      }}
    >
      {headless ? null : (
        <>
          <Box
            data-od-id="page-head"
            sx={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: "20px", mb: "18px" }}
          >
            <Box>
              <Typography sx={{ fontSize: 22, fontWeight: 650, letterSpacing: "-0.015em", lineHeight: 1.2, color: "text.primary" }}>
                {t("nav.cubepilot")}
              </Typography>
              <Typography sx={{ color: "text.secondary", fontSize: 13, mt: "5px" }}>{t("cubepilot.sub")}</Typography>
            </Box>
          </Box>
          {/* Its own row, as on every page here: the room's height comes from
              the card's own expand control, not from folding the tabs into
              the title's row. */}
          <Box
            role="tablist"
            aria-label={t("nav.cubepilot")}
            data-od-id="cubepilot-tabs"
            sx={{ display: "flex", borderBottom: 1, borderColor: "divider", mb: "18px" }}
          >
            {tabItems.map((item) => {
              const active = tab === item.id;
              return (
                <Box
                  key={item.id}
                  component="button"
                  type="button"
                  role="tab"
                  id={`tab-${item.id}`}
                  aria-selected={active}
                  aria-controls={`pane-${item.id}`}
                  onClick={() => setStoredTab(item.id)}
                  data-od-id={`cp-tab-${item.id}`}
                  sx={{
                    border: 0,
                    bgcolor: "transparent",
                    padding: "9px 0",
                    marginRight: "24px",
                    cursor: "pointer",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                    letterSpacing: "0.07em",
                    textTransform: "uppercase",
                    color: active ? "text.primary" : "text.secondary",
                    fontWeight: active ? 650 : 450,
                    position: "relative",
                    "&:hover": { color: "text.primary" },
                    "&::after": {
                      content: '""',
                      position: "absolute",
                      left: 0,
                      right: 0,
                      bottom: "-1px",
                      height: 2,
                      background: active ? "var(--accent)" : "transparent",
                    },
                  }}
                >
                  {item.label}
                </Box>
              );
            })}
          </Box>
        </>
      )}

      <Box
        hidden={tab !== "chat"}
        role="tabpanel"
        id="pane-chat"
        aria-labelledby="tab-chat"
        data-od-id="pane-chat"
        // The chat pane is what absorbs the leftover height: a flex container,
        // so the card inside it stretches rather than being told a number.
        sx={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}
      >
        <ChatPane roomExpanded={headless} onToggleRoom={() => setRoomExpanded((open) => !open)} />
      </Box>
      <Box hidden={tab !== "tasks"} role="tabpanel" id="pane-tasks" aria-labelledby="tab-tasks" data-od-id="pane-tasks">
        <TasksPane />
      </Box>
      <Box hidden={tab !== "config"} role="tabpanel" id="pane-config" aria-labelledby="tab-config" data-od-id="pane-config">
        <ConfigPane />
      </Box>
    </Box>
  );
}
