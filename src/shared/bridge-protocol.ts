// Page ↔ design-frame protocol (docs/SPEC.md §8.3).
//
// The page (our guest) talks to each artboard's nested frame with `postMessage(msg, '*')`
// — the frame has an opaque origin, so `'*'` is the only target that works. The design's
// own scripts share the realm with the bridge, so every frame → page message is advisory:
// the page accepts one only when `event.source === artboardIframe.contentWindow`, the
// shape validates here, and `artboardId` + `nonce` match the document it loaded. Nothing
// in this channel is privileged; it can only move pins, report sizes, ask to navigate
// within the design, or ask to open a URL the user then confirms.

import {
  ANCHOR_HTML_MAX,
  ANCHOR_SELECTOR_MAX,
  ANCHOR_TEXT_MAX,
  BRIDGE_ANCHORS_MAX,
  BRIDGE_ARTBOARD_ID_MAX,
  BRIDGE_COORD_MAX,
  BRIDGE_NONCE_MAX,
  BRIDGE_TAG_MAX,
  BRIDGE_TITLE_MAX,
  BRIDGE_URL_MAX,
} from './limits.ts';
import type { Rect } from './types.ts';

export const BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Marker the service's render mode puts at the start of `<head>` (§9.5); the guest's
 * `frame-doc.ts` replaces it with the bridge script. Exports never contain it.
 */
export const BRIDGE_PLACEHOLDER = '<!--dc-bridge-->';

export type BridgeMode = 'edit' | 'play';

/** `window.__DC`, set by `frame-doc.ts` before the bridge runs. */
export type BridgeInit = {
  artboardId: string;
  /** Design-relative file this document renders (`screens/home.html`, `index.html`). */
  file: string;
  mode: BridgeMode;
  /** Scroll position to restore after a reload. */
  scroll: { x: number; y: number };
  /** Random per document load; echoed on every message so stale documents are ignored. */
  nonce: string;
};

type Envelope<T extends string> = { dc: typeof BRIDGE_PROTOCOL_VERSION; type: T; artboardId: string; nonce: string };

// ---- Page → frame ----

export type AnchorQuery = { id: string; selector: string; text: string; html: string };

export type PageToFrameMessage =
  | Envelope<'init-ack'>
  | (Envelope<'set-mode'> & { mode: BridgeMode })
  /** Frame-px point; the bridge answers `hit`. */
  | (Envelope<'hit-test'> & { x: number; y: number })
  | (Envelope<'resolve-anchors'> & { anchors: AnchorQuery[] })
  | (Envelope<'scroll-by'> & { dx: number; dy: number })
  | (Envelope<'scroll-to'> & { x: number; y: number })
  | (Envelope<'highlight'> & { selector: string | null });

// ---- Frame → page ----

export type HitElement = { selector: string; text: string; html: string; rect: Rect; tag: string };
export type AnchorResult = { id: string; found: boolean; rect: Rect | null; exact: boolean };

export type FrameToPageMessage =
  | (Envelope<'ready'> & { docWidth: number; docHeight: number; title: string })
  | (Envelope<'size'> & { docWidth: number; docHeight: number })
  | (Envelope<'scroll'> & { x: number; y: number })
  /** Answer to `hit-test` at (`x`,`y`); `element` is null when nothing is under the point. */
  | (Envelope<'hit'> & { x: number; y: number; element: HitElement | null })
  | (Envelope<'anchors'> & { results: AnchorResult[] })
  /** In-design link: `href` is the design-relative path (`screens/checkout.html`), `hash` includes `#` or is empty. */
  | (Envelope<'navigate'> & { href: string; hash: string })
  | (Envelope<'open-external'> & { url: string })
  /** Forwarded only for ctrl/meta wheel, and any wheel in Edit mode. */
  | (Envelope<'wheel'> & { deltaX: number; deltaY: number; x: number; y: number; ctrl: boolean })
  | (Envelope<'key'> & { key: BridgeKey; ctrl: boolean; meta: boolean; shift: boolean });

/** Wall shortcuts the bridge forwards: Escape, Space, + (and = unshifted), −, 0, 1. */
export const BRIDGE_KEYS = ['Escape', ' ', '+', '=', '-', '0', '1'] as const;
export type BridgeKey = (typeof BRIDGE_KEYS)[number];

export type PageToFrameType = PageToFrameMessage['type'];
export type FrameToPageType = FrameToPageMessage['type'];

/** Artboard id used by the wall and the bridge: `<screen id | "artifact">@<viewport id>`. */
export const artboardIdOf = (screen: string | null, viewport: string): string => `${screen ?? 'artifact'}@${viewport}`;

// ---- Validation (pure; both ends use it) ----

type Rec = Record<string, unknown>;

const isRec = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStr = (value: unknown, max: number): value is string => typeof value === 'string' && value.length <= max;
const isId = (value: unknown, max: number): value is string => isStr(value, max) && value.length > 0;
const isNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= BRIDGE_COORD_MAX;
const isSize = (value: unknown): value is number => isNum(value) && value >= 0;
const isBool = (value: unknown): value is boolean => typeof value === 'boolean';
const isMode = (value: unknown): value is BridgeMode => value === 'edit' || value === 'play';
const isRect = (value: unknown): value is Rect =>
  isRec(value) && isNum(value.x) && isNum(value.y) && isSize(value.w) && isSize(value.h);
const isKey = (value: unknown): value is BridgeKey => (BRIDGE_KEYS as readonly unknown[]).includes(value);
const isList = <T>(value: unknown, max: number, item: (entry: unknown) => entry is T): value is T[] =>
  Array.isArray(value) && value.length <= max && value.every(item);

const isAnchorQuery = (value: unknown): value is AnchorQuery =>
  isRec(value) &&
  isId(value.id, BRIDGE_ARTBOARD_ID_MAX) &&
  isStr(value.selector, ANCHOR_SELECTOR_MAX) &&
  isStr(value.text, ANCHOR_TEXT_MAX) &&
  isStr(value.html, ANCHOR_HTML_MAX);

const isAnchorResult = (value: unknown): value is AnchorResult =>
  isRec(value) &&
  isId(value.id, BRIDGE_ARTBOARD_ID_MAX) &&
  isBool(value.found) &&
  isBool(value.exact) &&
  (value.rect === null || isRect(value.rect));

const isHitElement = (value: unknown): value is HitElement =>
  isRec(value) &&
  isStr(value.selector, ANCHOR_SELECTOR_MAX) &&
  isStr(value.text, ANCHOR_TEXT_MAX) &&
  isStr(value.html, ANCHOR_HTML_MAX) &&
  isRect(value.rect) &&
  isId(value.tag, BRIDGE_TAG_MAX);

const hasEnvelope = (value: Rec): boolean =>
  value.dc === BRIDGE_PROTOCOL_VERSION &&
  isId(value.artboardId, BRIDGE_ARTBOARD_ID_MAX) &&
  isId(value.nonce, BRIDGE_NONCE_MAX);

const PAGE_TO_FRAME: Record<PageToFrameType, (m: Rec) => boolean> = {
  'init-ack': () => true,
  'set-mode': (m) => isMode(m.mode),
  'hit-test': (m) => isNum(m.x) && isNum(m.y),
  'resolve-anchors': (m) => isList(m.anchors, BRIDGE_ANCHORS_MAX, isAnchorQuery),
  'scroll-by': (m) => isNum(m.dx) && isNum(m.dy),
  'scroll-to': (m) => isNum(m.x) && isNum(m.y),
  highlight: (m) => m.selector === null || isStr(m.selector, ANCHOR_SELECTOR_MAX),
};

const FRAME_TO_PAGE: Record<FrameToPageType, (m: Rec) => boolean> = {
  ready: (m) => isSize(m.docWidth) && isSize(m.docHeight) && isStr(m.title, BRIDGE_TITLE_MAX),
  size: (m) => isSize(m.docWidth) && isSize(m.docHeight),
  scroll: (m) => isNum(m.x) && isNum(m.y),
  hit: (m) => isNum(m.x) && isNum(m.y) && (m.element === null || isHitElement(m.element)),
  anchors: (m) => isList(m.results, BRIDGE_ANCHORS_MAX, isAnchorResult),
  navigate: (m) => isId(m.href, BRIDGE_URL_MAX) && isStr(m.hash, BRIDGE_URL_MAX) && (m.hash === '' || m.hash.startsWith('#')),
  'open-external': (m) => isId(m.url, BRIDGE_URL_MAX) && /^https?:\/\//i.test(m.url),
  wheel: (m) => isNum(m.deltaX) && isNum(m.deltaY) && isNum(m.x) && isNum(m.y) && isBool(m.ctrl),
  key: (m) => isKey(m.key) && isBool(m.ctrl) && isBool(m.meta) && isBool(m.shift),
};

const parseWith = <T>(table: Record<string, (m: Rec) => boolean>, data: unknown): T | null => {
  if (!isRec(data) || !hasEnvelope(data) || typeof data.type !== 'string') return null;
  if (!Object.hasOwn(table, data.type)) return null;
  const check = table[data.type];
  // Safe: the envelope and every field of this `type` were checked just above.
  return check !== undefined && check(data) ? (data as T) : null;
};

/** Page side: a validated frame message, or null for anything malformed. Check `event.source` before calling. */
export const parseFrameMessage = (data: unknown): FrameToPageMessage | null => parseWith<FrameToPageMessage>(FRAME_TO_PAGE, data);

/** Bridge side: a validated page message, or null. */
export const parsePageMessage = (data: unknown): PageToFrameMessage | null => parseWith<PageToFrameMessage>(PAGE_TO_FRAME, data);
