// Pure wall math (docs/SPEC.md §8.2): camera transforms, zoom around a point, fit, and the
// auto-grid layout (rows = screens, columns = viewports). Ported in spirit from
// design-canvas `viewer-client/src/canvas-controller.js` (zoomTo / wheel zoom / pan), rewritten
// as plain functions over an explicit camera so the page and tests share one implementation.
//
// Coordinates: "world" = wall px (artboards are laid out in it); "screen" = px inside the wall
// element. screen = world × scale + (x, y).

import type { Viewport } from '../shared/types.ts';
import { artboardIdOf } from '../shared/bridge-protocol.ts';
import {
  ARTBOARD_LABEL_HEIGHT,
  CAMERA_PAN_MAX,
  CAMERA_SCALE_MAX,
  CAMERA_SCALE_MIN,
  WALL_GAP,
  WHEEL_ZOOM_RATE,
} from '../shared/limits.ts';

export type Camera = { x: number; y: number; scale: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Box = { x: number; y: number; width: number; height: number };

export const DEFAULT_CAMERA: Readonly<Camera> = Object.freeze({ x: 0, y: 0, scale: 1 });
/** Step for the `+` / `−` buttons and keys. */
export const ZOOM_STEP = 1.25;
/** Screen px kept around content by `fitAll` / `focusArtboard`. */
export const FIT_PADDING = 48;
/** Narrowest uncovered wall a fit aims at; below it, fit uses the whole wall (KI-4). */
export const FIT_MIN_WIDTH = 240;

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export const clampScale = (scale: number): number =>
  Number.isFinite(scale) ? clamp(scale, CAMERA_SCALE_MIN, CAMERA_SCALE_MAX) : DEFAULT_CAMERA.scale;

export const clampCamera = (camera: Camera): Camera => ({
  x: Number.isFinite(camera.x) ? clamp(camera.x, -CAMERA_PAN_MAX, CAMERA_PAN_MAX) : 0,
  y: Number.isFinite(camera.y) ? clamp(camera.y, -CAMERA_PAN_MAX, CAMERA_PAN_MAX) : 0,
  scale: clampScale(camera.scale),
});

export const worldToScreen = (camera: Camera, point: Point): Point => ({
  x: point.x * camera.scale + camera.x,
  y: point.y * camera.scale + camera.y,
});

export const screenToWorld = (camera: Camera, point: Point): Point => ({
  x: (point.x - camera.x) / camera.scale,
  y: (point.y - camera.y) / camera.scale,
});

/** Zoom to `scale` (clamped) keeping the world point under the screen `point` fixed. */
export const zoomAt = (camera: Camera, scale: number, point: Point): Camera => {
  const next = clampScale(scale);
  const world = screenToWorld(camera, point);
  return clampCamera({ x: point.x - world.x * next, y: point.y - world.y * next, scale: next });
};

/** Multiply the scale by `factor` around `point` (`ZOOM_STEP` / `1 / ZOOM_STEP` for the buttons). */
export const zoomBy = (camera: Camera, factor: number, point: Point): Camera => zoomAt(camera, camera.scale * factor, point);

/** Ctrl/⌘ + wheel or pinch: `scale *= exp(-deltaY × WHEEL_ZOOM_RATE)` around the cursor. */
export const wheelZoom = (camera: Camera, deltaY: number, point: Point): Camera =>
  Number.isFinite(deltaY) ? zoomAt(camera, camera.scale * Math.exp(-deltaY * WHEEL_ZOOM_RATE), point) : camera;

/** Move the wall by screen px (drag deltas; wheel pans pass `-deltaX, -deltaY`). */
export const panBy = (camera: Camera, dx: number, dy: number): Camera =>
  Number.isFinite(dx) && Number.isFinite(dy) ? clampCamera({ ...camera, x: camera.x + dx, y: camera.y + dy }) : camera;

export const unionBoxes = (boxes: readonly Box[]): Box | null => {
  if (boxes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
};

export type FitOptions = { padding?: number; maxScale?: number };

/** Camera that shows `box` whole and centred in `viewport`, never above `maxScale` (default 100 %). */
export const fitBox = (box: Box, viewport: Size, options: FitOptions = {}): Camera => {
  const padding = options.padding ?? FIT_PADDING;
  const maxScale = options.maxScale ?? 1;
  const availableWidth = Math.max(1, viewport.width - padding * 2);
  const availableHeight = Math.max(1, viewport.height - padding * 2);
  const fit = Math.min(availableWidth / Math.max(1, box.width), availableHeight / Math.max(1, box.height));
  const scale = clampScale(Math.min(maxScale, fit));
  return clampCamera({
    x: viewport.width / 2 - (box.x + box.width / 2) * scale,
    y: viewport.height / 2 - (box.y + box.height / 2) * scale,
    scale,
  });
};

/**
 * The part of the wall a fit should fill: the wall minus what a drawer laid over its right edge
 * covers, unless that leaves less than `minWidth` — then the whole wall (a near-zero zoom into a
 * sliver helps nobody). Padding shrinks with a narrow area so the content keeps the room.
 */
export const fitArea = (wall: Size, coveredRight: number, minWidth: number = FIT_MIN_WIDTH): Size & { padding: number } => {
  const visible = wall.width - Math.max(0, coveredRight);
  const width = visible >= minWidth ? visible : wall.width;
  return { width, height: wall.height, padding: width < 480 ? 24 : 56 };
};

/** Fit every box (artboards with their labels). No boxes → the default camera. */
export const fitAll = (boxes: readonly Box[], viewport: Size, options?: FitOptions): Camera => {
  const bounds = unionBoxes(boxes);
  return bounds ? fitBox(bounds, viewport, options) : { ...DEFAULT_CAMERA };
};

/** Double-click a label: fit that artboard (label included), up to 100 %. */
export const focusArtboard = (artboard: WallArtboard, viewport: Size, options?: FitOptions): Camera =>
  fitBox(artboardBox(artboard), viewport, options);

// ---- Auto-grid layout ----

/** A wall row: a canvas screen, or the artifact (`id: null`). */
export type WallScreen = { id: string | null; title: string; viewports?: readonly string[] };

export type WallArtboard = {
  /** `artboardIdOf(screen, viewport.id)`. */
  id: string;
  screen: string | null;
  screenTitle: string;
  viewport: Viewport;
  row: number;
  col: number;
  /** The design frame, world px, at the viewport's size. */
  frame: Box;
  /** The label strip above the frame ("Home · Laptop 1280×800"). */
  label: Box;
};

export type WallLayout = {
  artboards: WallArtboard[];
  /** Union of every frame and label; null when there is nothing to show. */
  bounds: Box | null;
};

export type LayoutOptions = { gap?: number; labelHeight?: number };

export const artboardBox = (artboard: WallArtboard): Box => ({
  x: artboard.label.x,
  y: artboard.label.y,
  width: artboard.frame.width,
  height: artboard.label.height + artboard.frame.height,
});

/**
 * Rows = screens (in order), columns = viewports (in order). Column width = the widest
 * viewport in that column; row height = label + the tallest viewport that row shows. A screen's
 * optional `viewports` subset leaves its other cells empty; a row with no cell is dropped.
 */
export const layoutWall = (screens: readonly WallScreen[], viewports: readonly Viewport[], options: LayoutOptions = {}): WallLayout => {
  const gap = options.gap ?? WALL_GAP;
  const labelHeight = options.labelHeight ?? ARTBOARD_LABEL_HEIGHT;

  const columnX: number[] = [];
  let x = 0;
  for (const viewport of viewports) {
    columnX.push(x);
    x += viewport.width + gap;
  }

  const artboards: WallArtboard[] = [];
  let y = 0;
  let row = 0;
  for (const screen of screens) {
    const shown = new Set(screen.viewports ?? viewports.map((viewport) => viewport.id));
    const cells = viewports.map((viewport, col) => ({ viewport, col })).filter(({ viewport }) => shown.has(viewport.id));
    if (cells.length === 0) continue;
    const rowHeight = Math.max(...cells.map(({ viewport }) => viewport.height));
    for (const { viewport, col } of cells) {
      const left = columnX[col] ?? 0;
      artboards.push({
        id: artboardIdOf(screen.id, viewport.id),
        screen: screen.id,
        screenTitle: screen.title,
        viewport,
        row,
        col,
        label: { x: left, y, width: viewport.width, height: labelHeight },
        frame: { x: left, y: y + labelHeight, width: viewport.width, height: viewport.height },
      });
    }
    y += labelHeight + rowHeight + gap;
    row += 1;
  }

  return { artboards, bounds: unionBoxes(artboards.map(artboardBox)) };
};

/** Whether a world box is on screen, with `margin` × the viewport size around it (frame budget, §8.4). */
export const isBoxVisible = (camera: Camera, box: Box, viewport: Size, margin = 0): boolean => {
  const topLeft = worldToScreen(camera, { x: box.x, y: box.y });
  const width = box.width * camera.scale;
  const height = box.height * camera.scale;
  const mx = viewport.width * margin;
  const my = viewport.height * margin;
  return topLeft.x + width >= -mx && topLeft.x <= viewport.width + mx && topLeft.y + height >= -my && topLeft.y <= viewport.height + my;
};
