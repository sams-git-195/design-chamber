# Luxury
**id:** luxury · **best for:** jewellery, hospitality, fashion, high-end real estate, premium services

**Mood:** restrained, dark, unhurried. Space, fine type and a single metallic note.

**Type:** display — elegant high-contrast serif or didone (Cormorant Garamond, "Bodoni Moda", fallback Georgia), light weight; body — refined sans (Jost, "Helvetica Neue", fallback "Segoe UI"). Body 16px, line-height 1.7; labels uppercase 11–12px, 0.18em tracking.

```css
:root {
  color-scheme: dark;
  --bg: #0f0d0b; --surface: #181512; --surface-2: #221e19;
  --fg: #efe8dc; --fg-muted: #a79c8a; --border: #34302a;
  --accent: #c8a45c; --accent-fg: #14100a;
  --success: #7aa87a; --warning: #c8a45c; --danger: #c0604f;
  --font-display: "Cormorant Garamond", "Bodoni Moda", Georgia, serif;
  --font-body: "Jost", "Helvetica Neue", "Segoe UI", sans-serif;
  --font-mono: ui-monospace, Menlo, monospace;
  --radius-sm: 0; --radius-md: 2px; --radius-lg: 4px;
  --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 40px; --space-6: 64px; --space-7: 104px; --space-8: 160px;
  --shadow-1: none;
}
```

**Motifs:** full-bleed photography with generous margins, hairline gold rules, small-caps labels, centered monogram, slow fades (≤600ms, reduced-motion safe), outlined (not filled) secondary buttons, asymmetric image/text offsets.

**Do:** gold only for thin lines, labels and the primary action; very large spacing; few elements per screen; real product/place names and prices.
**Don't:** gradient "gold", bevels, ornate flourishes, crowded layouts, discount-banner energy.
