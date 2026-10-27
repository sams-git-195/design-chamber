# Poster / Print
**id:** poster-print · **best for:** posters, flyers, social posts (1080×1080), A4 print sheets, one-page handouts, event announcements

**Mood:** graphic, bold, composed on a fixed page. Few elements, big contrast, strong grid.

**Type:** display — heavy condensed or slab (Anton, "Bebas Neue", fallback Impact, "Arial Narrow" bold); secondary — clean sans (Archivo, "Helvetica Neue", Arial). One giant headline (≥12% of page height), one subhead, small details. Leading 0.9–1.0 on display.

```css
:root {
  --bg: #f3efe6; --surface: #ffffff; --surface-2: #e7e0d0;
  --fg: #14110f; --fg-muted: #4a443c; --border: #14110f;
  --accent: #e4262c; --accent-fg: #ffffff;
  --accent-2: #1f3fa0;
  --success: #1f7a45; --warning: #e0a000; --danger: #e4262c;
  --font-display: "Anton", "Bebas Neue", Impact, "Arial Narrow", sans-serif;
  --font-body: "Archivo", "Helvetica Neue", Arial, sans-serif;
  --font-mono: ui-monospace, Menlo, monospace;
  --radius-sm: 0; --radius-md: 0; --radius-lg: 0;
  --space-1: 6px; --space-2: 12px; --space-3: 18px; --space-4: 24px; --space-5: 36px; --space-6: 48px; --space-7: 72px;
  --shadow-1: none;
}
```

**Motifs:** one dominant image or shape, oversized type cropped by the edge, colour blocks, rules and tick marks, a strong date/place info band, registration marks, halftone via CSS/SVG.

**Do:** fix the page size (`width:794px; height:1123px` for A4 @96dpi, or 1080×1080) with `@page` and `print-color-adjust: exact`; margins ≥6% of width; two colours plus ink; real event/product details.
**Don't:** scrolling web-page layouts, small text near edges, more than three emphasis sizes, stock-photo collage.
