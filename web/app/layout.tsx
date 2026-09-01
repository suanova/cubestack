import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

import { AppShell } from "@/components/shell/AppShell";
import { DocumentMeta } from "@/components/shell/DocumentMeta";
import { EmotionCacheProvider } from "@/components/shell/EmotionCacheProvider";
import { PlatformInitScript } from "@/components/shell/PlatformInitScript";
import { dictionaries } from "@/lib/i18n/dictionaries";

// Same theme bootstrap as the static prototype pages (public/overview.html):
// read localStorage["cubestack-theme"] (with a ?theme= override and a
// prefers-color-scheme fallback) and stamp it onto <html data-theme> before
// the first paint, so the dashboard pages render in the stored theme.
// Locale bootstrap mirrors it: localStorage["cubestack-locale"] → the browser's
// language → zh-CN, stamped onto <html data-locale> and <html lang>.
const platformInitScript = `(function(){try{var t=localStorage.getItem('cubestack-theme');var m=/[#?&]theme=(dark|light)/.exec(location.href);if(m)t=m[1];if(!t&&window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches)t='dark';if(t)document.documentElement.dataset.theme=t;}catch(e){}})();(function(){try{var l=localStorage.getItem('cubestack-locale');if(l!=='zh-CN'&&l!=='zh-TW'&&l!=='en'){var n=(navigator.language||'zh-CN').toLowerCase();l=n.indexOf('zh')===0?(/tw|hk|mo|hant/.test(n)?'zh-TW':'zh-CN'):(n.indexOf('en')===0?'en':'zh-CN');}document.documentElement.dataset.locale=l;document.documentElement.lang=l;}catch(e){}})()`;

// Server-rendered metadata uses the product default locale (zh-CN); the
// client-side DocumentMeta component re-stamps title/description from the
// stored locale after hydration.
export const metadata: Metadata = {
  title: dictionaries["zh-CN"]["app.title"],
  description: dictionaries["zh-CN"]["app.description"],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // suppressHydrationWarning: the bootstrap script may change lang before
    // hydration; data-theme/data-locale are never React-rendered.
    <html lang="zh-CN" suppressHydrationWarning className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <PlatformInitScript script={platformInitScript} />
        <EmotionCacheProvider>
          <DocumentMeta />
          <AppShell>{children}</AppShell>
        </EmotionCacheProvider>
      </body>
    </html>
  );
}
