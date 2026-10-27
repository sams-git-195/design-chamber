// Pure wall geometry the UI adds on top of the guest camera: mapping between screen, world
// and frame pixels, pin placement and clustering, label room, and focus rules.

import type { Rect, RelPoint } from '../../shared/types.ts';

export type CameraLike = { x: number; y: number; scale: number };
export type BoardRect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };

/** Wall-surface pixel → artboard frame pixel (what the bridge's `hit-test` wants). */
export const screenToFrame = (camera: CameraLike, board: BoardRect, screen: Point): Point => ({
  x: (screen.x - camera.x) / camera.scale - board.x,
  y: (screen.y - camera.y) / camera.scale - board.y,
});

/** Artboard frame pixel → wall-surface pixel. */
export const frameToScreen = (camera: CameraLike, board: BoardRect, frame: Point): Point => ({
  x: camera.x + (board.x + frame.x) * camera.scale,
  y: camera.y + (board.y + frame.y) * camera.scale,
});

export const contains = (board: BoardRect, world: Point): boolean =>
  world.x >= board.x && world.y >= board.y && world.x <= board.x + board.w && world.y <= board.y + board.h;

export const screenToWorld = (camera: CameraLike, screen: Point): Point => ({
  x: (screen.x - camera.x) / camera.scale,
  y: (screen.y - camera.y) / camera.scale,
});

/** The artboard under a wall-surface point, topmost last in the list. */
export const boardAt = <T extends { rect: BoardRect }>(camera: CameraLike, boards: readonly T[], screen: Point): T | null => {
  const world = screenToWorld(camera, screen);
  for (let index = boards.length - 1; index >= 0; index -= 1) {
    const board = boards[index];
    if (board && contains(board.rect, world)) return board;
  }
  return null;
};

/** Where a pin sits in frame pixels: inside the element rect at the stored relative point, minus the frame's scroll. */
export const pinFramePoint = (rect: Rect, point: RelPoint, scroll: Point): Point => ({
  x: rect.x + rect.w * point.x - scroll.x,
  y: rect.y + rect.h * point.y - scroll.y,
});

/** Artboards the live-frame budget keeps loaded: those nearest the wall's centre, among the visible ones. */
export const liveBoards = <T extends { id: string; rect: BoardRect }>(
  boards: readonly T[],
  camera: CameraLike,
  surface: { w: number; h: number },
  budget: number,
  margin: number,
): T[] => {
  const left = -surface.w * margin;
  const top = -surface.h * margin;
  const right = surface.w * (1 + margin);
  const bottom = surface.h * (1 + margin);
  const centre = { x: surface.w / 2, y: surface.h / 2 };
  const visible = boards
    .map((board) => {
      const sx = camera.x + board.rect.x * camera.scale;
      const sy = camera.y + board.rect.y * camera.scale;
      const sw = board.rect.w * camera.scale;
      const sh = board.rect.h * camera.scale;
      const on = sx + sw >= left && sx <= right && sy + sh >= top && sy <= bottom;
      const distance = Math.hypot(sx + sw / 2 - centre.x, sy + sh / 2 - centre.y);
      return { board, on, distance };
    })
    .filter((entry) => entry.on)
    .sort((a, b) => a.distance - b.distance);
  return visible.slice(0, Math.max(1, budget)).map((entry) => entry.board);
};

/** The same zoom, with the content's top edge `padding` below the top of the surface instead of centred. */
export const alignTop = (camera: CameraLike, bounds: BoardRect, padding: number): CameraLike => ({ ...camera, y: padding - bounds.y * camera.scale });

/** Keyboard pan step in screen pixels: bigger with Shift. */
export const nudgeStep = (shift: boolean): number => (shift ? 240 : 60);

// ---- Pins at any zoom: pins keep one screen size, so at low zoom neighbours collide ----

/** A pin's position on its artboard, frame px, in display order (lowest comment number first). */
export type PinSpot = { id: string; x: number; y: number };
/** Pins drawn as one: the first pin's spot anchors the group. */
export type PinGroup = { ids: string[]; x: number; y: number };

/** At or above this zoom pins that still overlap fan out into a row instead of folding into a count. */
export const PIN_FAN_SCALE = 1;

/**
 * Groups pins whose centres are less than `size` screen px apart at `scale` (a pin is `size` px
 * wide on screen whatever the zoom). Greedy in display order, so the lowest number anchors.
 */
export const clusterPins = (pins: readonly PinSpot[], scale: number, size: number): PinGroup[] => {
  const groups: PinGroup[] = [];
  const reach = size / Math.max(scale, 1e-6);
  for (const pin of pins) {
    const near = groups.find((group) => Math.hypot(group.x - pin.x, group.y - pin.y) < reach);
    if (near) near.ids.push(pin.id);
    else groups.push({ ids: [pin.id], x: pin.x, y: pin.y });
  }
  return groups;
};

/** A group laid out as a row of whole pins starting at its anchor, `gap` screen px apart. */
export const fanOut = (group: PinGroup, scale: number, size: number, gap = 4): PinSpot[] =>
  group.ids.map((id, index) => ({ id, x: group.x + (index * (size + gap)) / Math.max(scale, 1e-6), y: group.y }));

/**
 * The zoom a click on a folded group goes to: enough to pull its pins apart, at least double
 * the current one, never past `PIN_FAN_SCALE` (from there the group fans out instead).
 */
export const separatingScale = (spots: readonly PinSpot[], scale: number, size: number): number => {
  let closest = Infinity;
  for (let i = 0; i < spots.length; i += 1) {
    for (let j = i + 1; j < spots.length; j += 1) {
      const a = spots[i];
      const b = spots[j];
      if (a && b) closest = Math.min(closest, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }
  const needed = closest > 0 && Number.isFinite(closest) ? (size * 1.5) / closest : PIN_FAN_SCALE;
  return Math.min(PIN_FAN_SCALE, Math.max(scale * 2, needed));
};

/** Widest a label of the rightmost column may grow past its artboard, screen px. */
export const LABEL_TAIL_MAX = 260;

/**
 * Screen width for an artboard's label: the artboard's width, plus the gap up to the next
 * column (`nextX`, world px; null for the rightmost column, which may run on to
 * `LABEL_TAIL_MAX`), so a zoomed-out phone column still reads "Home · Phone · 390×844".
 */
export const labelWidth = (rect: BoardRect, nextX: number | null, scale: number, spacing = 12): number => {
  const own = rect.w * scale;
  const room = nextX === null ? LABEL_TAIL_MAX : (nextX - rect.x) * scale - spacing;
  return Math.max(own, room);
};
