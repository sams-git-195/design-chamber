# Minimal SaaS
**id:** minimal-saas · **best for:** product landing pages, settings/app shells, developer tools with a crisp brand

**Mood:** calm, precise, trustworthy. Neutral canvas, one distinct accent, razor-thin structure.

**Type:** one tight grotesque family for display and body — Geist or "Instrument Sans" (fallback system-ui, "Segoe UI"); mono for code (Geist Mono, ui-monospace). Scale ×1.2, display weight 600 with −0.02em tracking; body 15–16px.

```css
:root {
  --bg: #ffffff; --surface: #f7f7f5; --surface-2: #efeeea;
  --fg: #0e1111; --fg-muted: #5b6360; --border: #e4e6e3;
  --accent: #0f766e; --accent-fg: #ffffff;
  --success: #15803d; --warning: #a16207; --danger: #b91c1c;
  --font-display: "Geist", "Instrument Sans", system-ui, "Segoe UI", sans-serif;
  --font-body: "Geist", "Instrument Sans", system-ui, "Segoe UI", sans-serif;
  --font-mono: "Geist Mono", ui-monospace, Menlo, monospace;
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 80px;
  --shadow-1: 0 1px 2px rgb(14 17 17 / .06);
}
```

**Motifs:** 1px borders instead of fills, product UI fragments as the hero, a left-aligned headline with a real sub-line, dense-but-calm feature lists, keyboard-shortcut chips, hover lift ≤2px.

**Do:** 4/8px rhythm; single accent on primary action and links only; real UI as proof; generous section spacing.
**Don't:** purple/indigo accent, gradient hero, three-equal-card feature row by default, heavy shadows, emoji icons.
