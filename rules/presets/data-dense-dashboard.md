# Data-Dense Dashboard
**id:** data-dense-dashboard · **best for:** admin consoles, analytics, ops/finance tools, API and developer dashboards

**Mood:** focused, instrument-panel, quietly powerful. Density is a feature; colour means status.

**Type:** one neutral UI sans (IBM Plex Sans, "Segoe UI", system-ui) plus mono for IDs/values (JetBrains Mono, ui-monospace). Base 13–14px, scale ×1.125, tabular numerals everywhere, row height 32–36px.

```css
:root {
  color-scheme: dark;
  --bg: #0d1117; --surface: #151b23; --surface-2: #1d252f;
  --fg: #e6edf3; --fg-muted: #9aa4af; --border: #2b3440;
  --accent: #3fb6a8; --accent-fg: #04201d;
  --success: #3fb950; --warning: #d29922; --danger: #f85149;
  --font-display: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-body: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
  --radius-sm: 3px; --radius-md: 6px; --radius-lg: 8px;
  --space-1: 2px; --space-2: 4px; --space-3: 8px; --space-4: 12px; --space-5: 16px; --space-6: 24px; --space-7: 32px;
  --shadow-1: 0 0 0 1px var(--border);
}
```

**Motifs:** compact tables with sticky headers and right-aligned numeric columns, sparklines/inline bars (SVG), status dots with text, segmented filter bars, KPI strip, keyboard hints, split panes.

**Do:** Loading/Empty/Error/Edge states for every panel; sort/filter affordances; units on every number; a light variant when asked.
**Don't:** decorative charts, 3D, rainbow palettes, giant padding, invented metrics not marked as sample data.
