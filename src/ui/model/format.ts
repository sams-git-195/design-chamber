// Pure display helpers shared by the rail and the page. No DOM, no host calls.

import type { Viewport } from '../../shared/types.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "just now", "4 min. ago", "yesterday" — in the host locale. Falls back to a date for old items. */
export const relativeTime = (iso: string, nowMs: number, locale: string): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const diff = nowMs - then;
  if (diff < 45 * SECOND) return 'just now';
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: 'short' });
  if (diff < HOUR) return rtf.format(-Math.max(1, Math.round(diff / MINUTE)), 'minute');
  if (diff < DAY) return rtf.format(-Math.round(diff / HOUR), 'hour');
  if (diff < 14 * DAY) return rtf.format(-Math.round(diff / DAY), 'day');
  return new Date(then).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: diff > 300 * DAY ? 'numeric' : undefined });
};

export const viewportSize = (viewport: Pick<Viewport, 'width' | 'height'>): string => `${viewport.width}×${viewport.height}`;

/** "Laptop 1280×800". */
export const viewportLabel = (viewport: Viewport): string => `${viewport.label} ${viewportSize(viewport)}`;

/** An artboard's label: "Home" + "Phone · 390×844", and the whole line for its tooltip. */
export const artboardLabel = (screenTitle: string, viewport: Viewport): { name: string; detail: string; full: string } => {
  const detail = `${viewport.label} · ${viewportSize(viewport)}`;
  return { name: screenTitle, detail, full: `${screenTitle} · ${detail}` };
};

/** Camera scale → whole percent, as the toolbar shows it. */
export const zoomPercent = (scale: number): string => `${Math.round(scale * 100)}%`;

export const plural = (count: number, one: string, many: string = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** Last path segment of a folder, for compact labels ("Designs"). */
export const folderName = (path: string): string => {
  const parts = path.split(/[\\/]+/).filter((part) => part !== '');
  return parts[parts.length - 1] ?? path;
};

/**
 * A long folder path shortened in the middle, keeping the drive (or root) and as many trailing
 * folders as fit, never cutting the last one unless it alone is longer than `max`:
 * `C:\Users\you\AppData\Local\Temp\dc-smoke-designs` → `C:\…\Temp\dc-smoke-designs`.
 * Show the full path in a tooltip next to it.
 */
export const middlePath = (path: string, max = 48): string => {
  if (path.length <= max) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]+/);
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  const head = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? path;
  const build = (tail: readonly string[]): string => `${head}${sep}…${sep}${tail.join(sep)}`;
  const tail = [last];
  for (let index = parts.length - 2; index > 0; index -= 1) {
    const next = [parts[index] ?? '', ...tail];
    if (build(next).length > max) break;
    tail.unshift(parts[index] ?? '');
  }
  const short = build(tail);
  if (parts.length > 2 && short.length <= max) return short;
  return last.length + 2 <= max ? `…${sep}${last}` : `${last.slice(0, Math.max(1, max - 1))}…`;
};
