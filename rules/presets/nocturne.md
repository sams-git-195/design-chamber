# Nocturne
**id:** nocturne · **best for:** media, music, film, gaming, product showcases, ambient/evening apps — dark, cinematic, atmospheric

**Mood:** deep ink-blue night, warm amber light. Atmosphere through depth and grain, not neon.

**Type:** display — characterful grotesque ("Bricolage Grotesque", Syne, fallback "Segoe UI" semibold); body — readable humanist sans (Figtree, "Source Sans 3", fallback system-ui). Large display, tight tracking; body 16px weight 400, muted tone for secondary.

```css
:root {
  color-scheme: dark;
  --bg: #0a1118; --surface: #101a24; --surface-2: #182533;
  --fg: #e9eef2; --fg-muted: #98a7b5; --border: #22313f;
  --accent: #ffb454; --accent-fg: #1a1004;
  --accent-2: #6fd3c9;
  --success: #5fd39a; --warning: #ffb454; --danger: #ff7a7a;
  --font-display: "Bricolage Grotesque", "Syne", "Segoe UI", system-ui, sans-serif;
  --font-body: "Figtree", "Source Sans 3", system-ui, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, Menlo, monospace;
  --radius-sm: 6px; --radius-md: 12px; --radius-lg: 20px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 40px; --space-7: 64px; --space-8: 104px;
  --shadow-1: 0 12px 40px rgb(0 0 0 / .45);
}
```

**Motifs:** one warm radial glow behind the focal element, subtle film grain (inline SVG noise at 4–6% opacity), full-bleed imagery with dark overlays, staggered fade-up on load (reduced-motion safe), large type over imagery with verified contrast.

**Do:** keep surfaces on one blue-ink ramp; amber for the single primary action and key highlights; verify contrast of text over imagery/glow.
**Don't:** purple/magenta neon, blurry glass panels, rainbow gradients, glow on everything, pure #000 backgrounds.
