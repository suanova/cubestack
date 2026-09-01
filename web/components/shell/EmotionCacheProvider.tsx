"use client";

// Emotion SSR cache for MUI, mirroring @mui/material-nextjs's
// AppRouterCacheProvider (v6.5.0). Without it Emotion renders each styled
// component's <style data-emotion> inline in the SSR body tree while the
// client injects the same styles into <head>, a structural mismatch that
// makes React regenerate the whole tree on hydration (and, cascading from
// that, warn about the layout's <script>). The cache runs in "compat" mode
// so Emotion's <Insertion>/<Global> render nothing on the server; the styles
// are instead flushed into <head> via useServerInsertedHTML, matching what
// the client does. We keep the implementation locally instead of installing
// @mui/material-nextjs because its peer range caps at Next 15 and this is
// the whole package, built on @emotion/cache which is already a dependency.

import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { useServerInsertedHTML } from "next/navigation";
import { ReactNode, useState } from "react";

export function EmotionCacheProvider({ children }: { children: ReactNode }) {
  const [registry] = useState(() => {
    const cache = createCache({ key: "mui" });
    cache.compat = true;
    const prevInsert = cache.insert;
    // Track the styles inserted in this render so useServerInsertedHTML can
    // flush them to <head> in chunks as the stream renders. Globals (from
    // <Global>, e.g. CssBaseline) are inserted with an empty selector.
    let inserted: Array<{ name: string; isGlobal: boolean }> = [];
    cache.insert = (...args) => {
      const [selector, serialized] = args;
      if (cache.inserted[serialized.name] === undefined) {
        inserted.push({ name: serialized.name, isGlobal: !selector });
      }
      return prevInsert(...args);
    };
    const flush = () => {
      const prevInserted = inserted;
      inserted = [];
      return prevInserted;
    };
    return { cache, flush };
  });

  useServerInsertedHTML(() => {
    const inserted = registry.flush();
    if (inserted.length === 0) return null;

    let styles = "";
    let dataEmotionAttribute = registry.cache.key;
    const globals: Array<{ name: string; style: string }> = [];
    for (const { name, isGlobal } of inserted) {
      const style = registry.cache.inserted[name];
      if (typeof style === "string") {
        if (isGlobal) {
          globals.push({ name, style });
        } else {
          styles += style;
          dataEmotionAttribute += ` ${name}`;
        }
      }
    }

    return (
      <>
        {globals.map(({ name, style }) => (
          <style
            key={name}
            data-emotion={`${registry.cache.key}-global ${name}`}
            dangerouslySetInnerHTML={{ __html: style }}
          />
        ))}
        {styles && (
          <style
            data-emotion={dataEmotionAttribute}
            dangerouslySetInnerHTML={{ __html: styles }}
          />
        )}
      </>
    );
  });

  return <CacheProvider value={registry.cache}>{children}</CacheProvider>;
}
