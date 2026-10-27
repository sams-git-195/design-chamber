# Technical Mono
**id:** technical-mono · **best for:** CLIs, docs, developer products, infra, changelogs, engineering culture

**Mood:** terminal-honest, precise, text-first. Monospace as identity; colour as syntax.

**Type:** monospace for display and body (JetBrains Mono, "IBM Plex Mono", fallback ui-monospace, Menlo, Consolas); optionally one sans for long prose. Base 14–15px, line-height 1.6, scale ×1.2; headings differ by weight and `#`-style prefixes as much as size.

```css
:root {
  color-scheme: dark;
  --bg: #0a0e0b; --surface: #111712; --surface-2: #19211b;
  --fg: #d6e3d8; --fg-muted: #8a9a8d; --border: #25302a;
  --accent: #4ade80; --accent-fg: #052010;
  --success: #4ade80; --warning: #fbbf24; --danger: #f87171;
  --font-display: "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --font-body: "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --font-mono: "JetBrains Mono", "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
  --radius-sm: 2px; --radius-md: 4px; --radius-lg: 6px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 40px; --space-7: 64px;
  --shadow-1: none;
}
```

**Motifs:** prompt glyphs (`$`, `>`), box-drawing rules, code blocks with real commands, key/value tables, inline diffs, status lines, copy buttons, a blinking cursor (reduced-motion safe).

**Do:** real, runnable commands and output; syntax colour that carries meaning; left-aligned everything; a light variant (#f6f7f4 bg / #14201a fg) when asked.
**Don't:** green-rain "hacker" cliché, neon glow, invented benchmarks, ASCII art standing in for content.
