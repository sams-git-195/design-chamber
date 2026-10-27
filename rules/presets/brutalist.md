# Brutalist
**id:** brutalist · **best for:** studios, portfolios, zines, manifestos — anything raw and unapologetic

**Mood:** raw, loud, structural. Visible grid, hard edges, oversized type; no polish for polish's sake.

**Type:** display — heavy grotesque or condensed (Archivo Black, fallback "Arial Black", Impact); body — mono or plain grotesque (IBM Plex Mono, "Courier New"). Extreme sizes: display `clamp(3rem, 12vw, 10rem)`, leading 0.9; body 16px.

```css
:root {
  --bg: #f2f0e6; --surface: #ffffff; --surface-2: #e2dfd0;
  --fg: #000000; --fg-muted: #3d3d3a; --border: #000000;
  --accent: #ff3b00; --accent-fg: #000000;
  --success: #00a34a; --warning: #ffcc00; --danger: #d00000;
  --font-display: "Archivo Black", "Arial Black", Impact, sans-serif;
  --font-body: "IBM Plex Mono", "Courier New", ui-monospace, monospace;
  --font-mono: "IBM Plex Mono", "Courier New", ui-monospace, monospace;
  --radius-sm: 0; --radius-md: 0; --radius-lg: 0;
  --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 32px; --space-6: 48px; --space-7: 80px;
  --shadow-1: 6px 6px 0 #000;
}
```

**Motifs:** 2–4px black borders, hard offset shadows, exposed grid lines, rotated stamps, giant numerals, repeated-word marquees, underlined links, raw table layouts.

**Do:** accent as a flat FILL with black text (never thin accent text on the bg); asymmetry; overlap; blunt, real copy.
**Don't:** rounded corners, soft shadows, gradients, glass, pastel; low contrast — raw must still be readable.
