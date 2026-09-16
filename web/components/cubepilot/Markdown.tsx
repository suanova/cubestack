"use client";

// Minimal Markdown renderer for assistant text and task reports.
//
// The reference chat renders full Markdown via react-markdown; this portal
// keeps the dependency footprint at zero and renders exactly the subset the
// demo content uses: fenced code blocks, tables, headings, ordered/unordered
// lists, paragraphs, `inline code` and **bold**. Raw HTML is never emitted.

import { Box, SxProps, Theme } from "@mui/material";
import { ReactNode, useMemo } from "react";

const softCode = "color-mix(in oklch, var(--fg) 6%, transparent)";

/** Inline: `code` and **bold** spans (order: code first, bold outside). */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  // Split on `code` first; then **bold** inside the plain segments.
  const codeParts = text.split(/(`[^`]+`)/g);
  codeParts.forEach((part, ci) => {
    if (part.startsWith("`") && part.endsWith("`") && part.length > 1) {
      out.push(
        <Box
          key={`${keyBase}-c${ci}`}
          component="code"
          sx={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.92em",
            bgcolor: softCode,
            border: "1px solid var(--border)",
            borderRadius: "4px",
            px: "4px",
            py: "0.5px",
            wordBreak: "break-word",
          }}
        >
          {part.slice(1, -1)}
        </Box>,
      );
      return;
    }
    const boldParts = part.split(/(\*\*[^*]+\*\*)/g);
    boldParts.forEach((b, bi) => {
      if (b.startsWith("**") && b.endsWith("**") && b.length > 4) {
        out.push(
          <Box key={`${keyBase}-b${ci}-${bi}`} component="strong" sx={{ fontWeight: 600 }}>
            {b.slice(2, -2)}
          </Box>,
        );
      } else if (b) {
        out.push(<Box key={`${keyBase}-t${ci}-${bi}`} component="span">{b}</Box>);
      }
    });
  });
  return out;
}

type Block =
  | { kind: "code"; lines: string[] }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "h"; level: number; text: string }
  | { kind: "ul"; items: string[] }
  | { kind: "ol"; items: string[] }
  | { kind: "p"; lines: string[] };

const tableSep = (line: string) =>
  /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes("-") && line.includes("|");

function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }
    if (line.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // closing fence
      blocks.push({ kind: "code", lines: buf });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && tableSep(lines[i + 1])) {
      const splitRow = (l: string) =>
        l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const header = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push({ kind: "h", level: h[1].length, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items });
      continue;
    }
    // Paragraph: consume until a blank line or a block-starting line.
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !/^#{1,3}\s/.test(lines[i]) &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !(lines[i].includes("|") && i + 1 < lines.length && tableSep(lines[i + 1]))
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "p", lines: buf });
  }
  return blocks;
}

function Table({ block }: { block: Extract<Block, { kind: "table" }> }) {
  return (
    <Box component="table" sx={{ borderCollapse: "collapse", fontSize: 12.5, my: "8px", width: "100%" }}>
      <Box component="thead">
        <Box component="tr">
          {block.header.map((c, i) => (
            <Box
              key={`h${i}`}
              component="th"
              sx={{
                textAlign: "left",
                borderBottom: "1px solid var(--border)",
                px: "10px",
                py: "6px",
                color: "text.secondary",
                fontWeight: 600,
              }}
            >
              {renderInline(c, `th${i}`)}
            </Box>
          ))}
        </Box>
      </Box>
      <Box component="tbody">
        {block.rows.map((r, ri) => (
          <Box key={`r${ri}`} component="tr">
            {r.map((c, ci) => (
              <Box
                key={`c${ci}`}
                component="td"
                sx={{ borderBottom: "1px solid var(--border)", px: "10px", py: "6px", verticalAlign: "top" }}
              >
                {renderInline(c, `td${ri}-${ci}`)}
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** Render a Markdown string with the documented subset. */
export function Markdown({ text, sx }: { text: string; sx?: SxProps<Theme> }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  return (
    <Box
      sx={{
        fontSize: 13.5,
        lineHeight: 1.7,
        wordBreak: "break-word",
        "& > *": { marginTop: "8px", "&:first-child": { marginTop: 0 } },
        ...sx,
      }}
    >
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "code":
            return (
              <Box
                key={i}
                component="pre"
                sx={{
                  fontFamily: "var(--font-mono)",
                  fontSize: 11.5,
                  lineHeight: 1.7,
                  bgcolor: "var(--fg)",
                  color: "color-mix(in oklch, var(--bg) 85%, transparent)",
                  borderRadius: "6px",
                  p: "10px 12px",
                  overflowX: "auto",
                  whiteSpace: "pre",
                  m: "8px 0",
                }}
              >
                {b.lines.join("\n")}
              </Box>
            );
          case "table":
            return <Table key={i} block={b} />;
          case "h": {
            const Tag = (b.level <= 1 ? "h4" : b.level === 2 ? "h5" : "h6") as "h4" | "h5" | "h6";
            return (
              <Box
                key={i}
                component={Tag}
                sx={{
                  m: "14px 0 6px",
                  fontSize: b.level === 1 ? 15 : 14,
                  fontWeight: 650,
                  lineHeight: 1.4,
                }}
              >
                {renderInline(b.text, `h${i}`)}
              </Box>
            );
          }
          case "ul":
            return (
              <Box key={i} component="ul" sx={{ m: "8px 0", pl: "20px" }}>
                {b.items.map((it, j) => (
                  <Box key={j} component="li" sx={{ mt: "3px" }}>
                    {renderInline(it, `ul${i}-${j}`)}
                  </Box>
                ))}
              </Box>
            );
          case "ol":
            return (
              <Box key={i} component="ol" sx={{ m: "8px 0", pl: "20px" }}>
                {b.items.map((it, j) => (
                  <Box key={j} component="li" sx={{ mt: "3px" }}>
                    {renderInline(it, `ol${i}-${j}`)}
                  </Box>
                ))}
              </Box>
            );
          default:
            return (
              <Box key={i} component="p" sx={{ m: "8px 0", whiteSpace: "pre-wrap" }}>
                {b.lines.map((l, j) => (
                  <Box key={j} component="span">
                    {j > 0 ? "\n" : null}
                    {renderInline(l, `p${i}-${j}`)}
                  </Box>
                ))}
              </Box>
            );
        }
      })}
    </Box>
  );
}
