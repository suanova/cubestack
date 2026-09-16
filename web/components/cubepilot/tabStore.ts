// External store for the 智能助手 tab selection (backed by localStorage),
// structured like lib/i18n/locale.ts: the page is statically prerendered
// (no localStorage at build time), so the server snapshot renders the
// default tab and the client snapshot restores the stored tab via a
// post-hydration re-render. A plain useState(readStoredTab) diverges
// silently here — React hydration does not diff aria-selected/hidden
// attributes, so the DOM would keep showing the prerendered default tab
// while the state already held the stored one.

export type CubepilotTab = "chat" | "tasks" | "config";

export const CUBEPILOT_TABS: CubepilotTab[] = ["chat", "tasks", "config"];

const TAB_KEY = "cubestack.cubepilot.tab";
const DEFAULT_TAB: CubepilotTab = "chat";

const tabListeners = new Set<() => void>();

export function readStoredTab(): CubepilotTab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return CUBEPILOT_TABS.includes(v as CubepilotTab) ? (v as CubepilotTab) : DEFAULT_TAB;
  } catch {
    return DEFAULT_TAB;
  }
}

export function setStoredTab(tab: CubepilotTab): void {
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // localStorage unavailable (private mode etc.); the selection still
    // applies for this session.
  }
  // "storage" events only reach other documents, so notify this
  // document's subscribers explicitly.
  for (const listener of tabListeners) listener();
}

export function subscribeTab(listener: () => void): () => void {
  tabListeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    // key === null covers localStorage.clear(); re-read the tab either way.
    if (event.key === TAB_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    tabListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

// Client snapshot reads localStorage; the server snapshot is the product
// default so the prerendered HTML and the hydration render agree.
export const getTabSnapshot = (): CubepilotTab => readStoredTab();
export const getServerTabSnapshot = (): CubepilotTab => DEFAULT_TAB;
