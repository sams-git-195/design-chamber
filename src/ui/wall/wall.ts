// The wall: an infinite pan/zoom surface of artboards (screens × viewports), each a sandboxed
// design frame. Used by the full-screen canvas page (P2), the artifact viewer (P6) and the
// compact rail viewer (R2). Camera math comes from the guest; this module owns the DOM, the
// pointer/keyboard input, hover outlines, pins, the comment composer and play-mode navigation.

import { mountSpinner } from '@openchamber/sdk/ui';

import { anchorFromHit, anchorStatesOf, commentsForArtboard, docToFrame, isInFrameView, trackPins, type PinPlacement, type PinTracker } from '../../guest/anchoring.ts';
import { DEFAULT_CAMERA, fitArea, fitBox, focusArtboard, layoutWall, panBy, wheelZoom, zoomAt, type Box, type Camera, type WallArtboard } from '../../guest/camera.ts';
import type { CreateCommentBody, DesignDetailResponse, PatchCommentBody } from '../../shared/api.ts';
import type { BridgeMode, FrameToPageMessage, HitElement } from '../../shared/bridge-protocol.ts';
import { ARTBOARD_LABEL_HEIGHT, FRAME_UNLOAD_MARGIN, PAGE_LIVE_FRAMES_MAX, RAIL_LIVE_FRAMES_MAX, WALL_GAP } from '../../shared/limits.ts';
import type { AnchorState, Comment, Screen, Viewport } from '../../shared/types.ts';
import { append, createScope, h } from '../components/dom.ts';
import { icon } from '../components/icons.ts';
import { btn, iconBtn } from '../components/kit.ts';
import { artboardLabel, viewportLabel } from '../model/format.ts';
import { pinAriaLabel, pinGlyph, pinNumbers } from '../model/comments-model.ts';
import { PIN_FAN_SCALE, alignTop, boardAt, clusterPins, fanOut, frameToScreen, labelWidth, liveBoards, nudgeStep, pinFramePoint, screenToFrame, separatingScale, type PinSpot, type Point } from '../model/wall-model.ts';
import { createComposer, createThread, type CardHandle } from './comment-ui.ts';
import { createFrameSlot, type FrameSlot } from './frame-slot.ts';

type Rect = { x: number; y: number; w: number; h: number };
/** One artboard as the wall draws it: the guest layout cell plus its screen and frame rect. */
type Artboard = { id: string; screen: Screen | null; viewport: Viewport; rect: Rect; cell: WallArtboard };
type WallLayout = { boards: Artboard[]; bounds: Rect };

const toRect = (box: Box): Rect => ({ x: box.x, y: box.y, w: box.width, h: box.height });

export type WallOptions = {
  slug: string;
  compact: boolean;
  /** Screen px of the wall's right edge a drawer currently covers (laid over it on narrow pages). */
  coveredRight?: () => number;
  initialCamera: Camera | null;
  onScale: (scale: number) => void;
  onCameraSettled: (camera: Camera) => void;
  createComment: (body: CreateCommentBody) => Promise<void>;
  updateComment: (id: string, patch: PatchCommentBody) => Promise<void>;
  deleteComment: (id: string) => Promise<void>;
  /** Play mode asked to open an external URL; the page confirms with the user. */
  onExternal: (url: string) => void;
  onNotice: (message: string) => void;
  /** Anchor resolution finished or a frame changed state: detached pins and remote references may have changed. */
  onStatus: () => void;
};

export type WallHandle = {
  el: HTMLElement;
  setDetail: (detail: DesignDetailResponse) => void;
  setMode: (mode: BridgeMode) => void;
  setHiddenViewports: (ids: readonly string[]) => void;
  /** Artifact viewer "Fill": show one synthetic viewport instead of the design's own; comments are off while it is set. */
  setViewportOverride: (viewport: Viewport | null) => void;
  /** Ids of comments whose element was not found in the current document. */
  detachedIds: () => ReadonlySet<string>;
  /** Anchor state of every pin a loaded artboard has placed, for the revision prompt. */
  anchorStates: () => Record<string, AnchorState>;
  /** Remote URLs the loaded documents referenced (blocked inside designs). */
  externalRefs: () => string[];
  /** Show a saved version (read only); `compare` splits each artboard: version left, current right. */
  setVersion: (version: string | null, compare: boolean) => void;
  setShowPins: (show: boolean) => void;
  /** Reload the artboards of these sources (screen ids; null = the artifact); all when omitted. Unwritten or failed artboards always retry. */
  reload: (sources?: ReadonlySet<string | null>) => void;
  zoomStep: (factor: number) => void;
  zoomReset: () => void;
  fit: () => void;
  /** Fit again unless the user moved the camera (the covered area changed). */
  refit: () => void;
  getCamera: () => Camera;
  /** Bring a comment's pin into view and open its thread. */
  focusComment: (id: string) => void;
  focus: () => void;
  dispose: () => void;
};

type Board = {
  art: Artboard;
  root: HTMLElement;
  placeholder: HTMLElement;
  overlay: HTMLElement;
  hover: HTMLElement;
  hoverTag: HTMLElement;
  selected: HTMLElement;
  label: HTMLElement;
  labelText: HTMLElement;
  labelStatus: HTMLElement;
  main: FrameSlot;
  compare: FrameSlot | null;
  /** Screen the frame currently shows; differs from `art.screen` after play-mode navigation. */
  screenId: string | null;
  scroll: Point;
  tracker: PinTracker;
  placements: PinPlacement[];
  pins: Map<string, HTMLButtonElement>;
  /** Count badges standing in for pins that would overlap at this zoom. */
  clusters: HTMLButtonElement[];
  live: boolean;
};

type Popover = { card: CardHandle; close: () => void; board: Board; commentId: string | null };

const HOVER_MIN_INTERVAL = 40;

export const createWall = (options: WallOptions, initialDetail: DesignDetailResponse): WallHandle => {
  const scope = createScope();
  let detail = initialDetail;
  let mode: BridgeMode = 'edit';
  let hidden = new Set<string>();
  let override: Viewport | null = null;
  let version: string | null = null;
  let compare = false;
  let showPins = true;
  let camera: Camera = options.initialCamera ?? { ...DEFAULT_CAMERA };
  let userMoved = options.initialCamera !== null;
  let surfaceSize = { w: 0, h: 0 };
  let layout: WallLayout = { boards: [], bounds: { x: 0, y: 0, w: 0, h: 0 } };
  const boards = new Map<string, Board>();
  let popover: Popover | null = null;
  let panning: { id: number; last: Point } | null = null;
  let spaceDown = false;
  let panTool = false;
  let pointer: { point: Point } | null = null;
  let hoverTimer = 0;
  let lastHitAt = 0;
  let pendingHit: { board: Board; frame: Point; purpose: 'hover' | 'click' } | null = null;
  let hoveredBoard: Board | null = null;
  let disposed = false;
  let syncQueued = false;
  let pinScale = camera.scale;

  const world = h('div', { class: 'dc-wall-world' });
  const labels = h('div', { class: 'dc-wall-labels' });
  const overlay = h('div', { class: 'dc-wall-overlay' });
  const surface = h(
    'div',
    {
      class: 'dc-wall',
      tabindex: '0',
      role: 'application',
      'aria-roledescription': 'canvas wall',
      'aria-label': 'Design wall. Arrow keys pan, plus and minus zoom, Shift+1 fits everything. Hold Space and drag to pan.',
      'data-mode': mode,
    },
    world,
    labels,
    overlay,
  );
  const liveBudget = options.compact ? RAIL_LIVE_FRAMES_MAX : PAGE_LIVE_FRAMES_MAX;

  // ---------------------------------------------------------------- data helpers

  const screens = (): readonly Screen[] => detail.design.screens;
  const fileOf = (screenId: string | null): string =>
    screenId === null ? (detail.design.entry ?? 'index.html') : (screens().find((s) => s.id === screenId)?.file ?? `screens/${screenId}.html`);
  const readOnly = (): boolean => version !== null;
  const comments = (): readonly Comment[] => detail.design.comments;
  const numbers = (): Map<string, number> => pinNumbers(comments());
  const commentsOf = (art: Artboard): Comment[] => commentsForArtboard(comments(), art.screen?.id ?? null, art.viewport.id);
  /** A pin's diameter on screen (CSS `--dc-pin`); it stays the same at every zoom. */
  const pinSize = (): number => (options.compact ? 18 : 24);
  const size = (): { width: number; height: number } => ({ width: surfaceSize.w, height: surfaceSize.h });
  const surfaceRect = (): DOMRect => surface.getBoundingClientRect();
  const local = (event: { clientX: number; clientY: number }): Point => {
    const rect = surfaceRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  // ---------------------------------------------------------------- camera

  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  const applyCamera = (): void => {
    world.style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    surface.style.setProperty('--dc-inv', String(1 / camera.scale));
    surface.style.setProperty('--dc-scale', String(camera.scale));
    surface.style.setProperty('--dc-grid', `${Math.max(8, 24 * camera.scale)}px`);
    surface.style.setProperty('--dc-grid-x', `${camera.x}px`);
    surface.style.setProperty('--dc-grid-y', `${camera.y}px`);
    surface.dataset.dense = camera.scale < 0.3 ? 'true' : 'false';
    for (const board of boards.values()) placeLabel(board);
    if (camera.scale !== pinScale) {
      // Which pins fold into a count depends on the zoom.
      pinScale = camera.scale;
      for (const board of boards.values()) paintPins(board);
    }
    options.onScale(camera.scale);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => options.onCameraSettled(camera), 400);
    queueSync();
  };

  const setCamera = (next: Camera, user: boolean): void => {
    camera = next;
    if (user) {
      userMoved = true;
      closePopover();
      clearHover();
    }
    applyCamera();
  };

  /** Fit everything; an artifact sits at the top of the wall like a page in a browser, not vertically centred. */
  const fitView = (): Camera => {
    const { bounds } = layout;
    const area = fitArea(size(), options.coveredRight?.() ?? 0);
    const padding = options.compact ? 16 : area.padding;
    const next = bounds.w > 0 && bounds.h > 0 ? fitBox({ x: bounds.x, y: bounds.y, width: bounds.w, height: bounds.h }, area, { padding }) : { ...DEFAULT_CAMERA };
    return detail.design.kind === 'artifact' ? alignTop(next, layout.bounds, padding) : next;
  };

  const fit = (): void => {
    userMoved = false;
    closePopover();
    camera = fitView();
    applyCamera();
  };

  // ---------------------------------------------------------------- boards

  const placeLabel = (board: Board): void => {
    const { rect } = board.art;
    const x = camera.x + rect.x * camera.scale;
    const y = camera.y + rect.y * camera.scale;
    const width = rect.w * camera.scale;
    const next = layout.boards.reduce<number | null>((nearest, other) => (other.rect.x > rect.x && (nearest === null || other.rect.x < nearest) ? other.rect.x : nearest), null);
    board.label.style.transform = `translate(${x}px, ${y - 26}px)`;
    // Never past the wall's right edge, so a long label ends in an ellipsis rather than a cut.
    board.label.style.width = `${Math.max(0, Math.min(labelWidth(rect, next, camera.scale), Math.max(width, surfaceSize.w - x - 8)))}px`;
    // Labels sit in the gap above their row; below a 24 px gap only the top row keeps one.
    board.label.hidden = width < 32 || (board.art.cell.row > 0 && (ARTBOARD_LABEL_HEIGHT + WALL_GAP) * camera.scale < 24);
  };

  const paintPlaceholder = (board: Board): void => {
    const state = board.main.state();
    const file = fileOf(board.screenId);
    board.placeholder.replaceChildren();
    board.placeholder.dataset.state = board.live ? state : 'idle';
    const inner = h('div', { class: 'dc-placeholder-inner' });
    if (!board.live || state === 'idle') {
      if (!board.live) append(inner, icon('layers', 20), h('p', { class: 'dc-placeholder-title' }, 'Paused'), h('p', { class: 'dc-placeholder-sub' }, 'Off screen. Pan here to load it.'));
      else mountSpinner(inner, { label: 'Loading…' });
    } else if (state === 'loading') {
      mountSpinner(inner, { label: `Loading ${board.art.screen?.title ?? 'artifact'}…` });
    } else if (state === 'missing') {
      append(
        inner,
        icon('layers', 20),
        h('p', { class: 'dc-placeholder-title' }, `${file} isn’t written yet`),
        h('p', { class: 'dc-placeholder-sub' }, 'It appears here the moment your agent saves it.'),
      );
    } else if (state === 'error') {
      const retry = btn({ label: 'Try again', variant: 'outline', size: 'sm', onClick: () => void loadBoard(board) });
      append(inner, icon('warning', 20), h('p', { class: 'dc-placeholder-title' }, 'This didn’t load'), h('p', { class: 'dc-placeholder-sub' }, board.main.error() ?? ''), retry.el);
    }
    board.placeholder.append(inner);
    board.root.dataset.state = board.live ? state : 'idle';
  };

  const paintLabel = (board: Board): void => {
    const { art } = board;
    const name = art.screen ? `${art.screen.title} · ${viewportLabel(art.viewport)}` : viewportLabel(art.viewport);
    const navigated = board.screenId !== (art.screen?.id ?? null);
    const shown = navigated ? (screens().find((s) => s.id === board.screenId)?.title ?? board.screenId ?? '') : (art.screen?.title ?? detail.design.title);
    const text = artboardLabel(shown, art.viewport);
    board.labelText.replaceChildren(h('span', { class: 'dc-label-name' }, text.name), h('span', { class: 'dc-label-sep', 'aria-hidden': 'true' }, '·'), h('span', { class: 'dc-label-dims' }, text.detail));
    board.labelText.title = text.full;
    board.labelStatus.replaceChildren();
    const state = board.main.state();
    if (state === 'loading' && board.live) append(board.labelStatus, h('span', { class: 'dc-status dc-status-spin', role: 'status', 'aria-label': 'Loading' }));
    if (state === 'missing') append(board.labelStatus, h('span', { class: 'dc-status', 'data-tone': 'warning' }, 'Not written yet'));
    if (state === 'error') append(board.labelStatus, h('span', { class: 'dc-status', 'data-tone': 'error' }, 'Didn’t load'));
    const meta = board.main.meta();
    const problems = meta ? [...meta.blocked, ...meta.missing] : [];
    if (problems.length > 0) {
      append(
        board.labelStatus,
        h('span', { class: 'dc-status', 'data-tone': 'warning', title: `Blocked or missing:\n${problems.join('\n')}`, tabindex: '0', role: 'img', 'aria-label': `${problems.length} references blocked or missing: ${problems.join(', ')}` }, `${problems.length} blocked`),
      );
    }
    if (meta && meta.external.length > 0) {
      append(board.labelStatus, h('span', { class: 'dc-status', 'data-tone': 'warning', title: `Remote files are blocked inside designs:\n${meta.external.join('\n')}`, tabindex: '0', role: 'img', 'aria-label': `${meta.external.length} remote files blocked` }, `${meta.external.length} remote`));
    }
    if (board.screenId !== (art.screen?.id ?? null)) {
      append(
        board.labelStatus,
        iconBtn({ icon: 'reset', label: `Reset ${name} to its first screen`, size: 'sm', onClick: () => resetBoard(board) }),
      );
    }
    if (version !== null) append(board.labelStatus, h('span', { class: 'dc-status', 'data-tone': 'info' }, compare ? `v${version.slice(1)} | current` : version));
  };

  const paint = (board: Board): void => {
    paintPlaceholder(board);
    paintLabel(board);
  };

  const makeBoard = (art: Artboard): Board => {
    const labelText = h('span', { class: 'dc-label-text' });
    const labelStatus = h('span', { class: 'dc-label-status' });
    const label = h('div', { class: 'dc-label' }, labelText, labelStatus);
    const placeholder = h('div', { class: 'dc-placeholder' });
    const hoverTag = h('span', { class: 'dc-hover-tag' });
    const hover = h('div', { class: 'dc-hover', hidden: true }, hoverTag);
    const selected = h('div', { class: 'dc-selected', hidden: true });
    const overlayLayer = h('div', { class: 'dc-board-overlay' }, hover, selected);
    const root = h('div', { class: 'dc-board', 'data-board': art.id });
    let self: Board | null = null;
    const main = createFrameSlot({
      slug: options.slug,
      artboardId: art.id,
      title: `${art.screen?.title ?? detail.design.title} at ${viewportLabel(art.viewport)}`,
      mode: () => (readOnly() ? 'play' : mode),
      scroll: () => self?.scroll ?? { x: 0, y: 0 },
      onState: () => {
        if (self && !disposed) {
          paint(self);
          options.onStatus();
        }
      },
    });
    const tracker = trackPins(main.channel, commentsOf(art));
    const board: Board = {
      art,
      root,
      placeholder,
      overlay: overlayLayer,
      hover,
      hoverTag,
      selected,
      label,
      labelText,
      labelStatus,
      main,
      compare: null,
      screenId: art.screen?.id ?? null,
      scroll: { x: 0, y: 0 },
      tracker,
      placements: [],
      pins: new Map(),
      clusters: [],
      live: false,
    };
    self = board;
    tracker.subscribe((placements, scroll) => {
      board.placements = placements;
      board.scroll = scroll;
      paintPins(board);
      options.onStatus();
    });
    main.channel.subscribe((message) => {
      if (!disposed) handleMessage(board, message);
    });
    root.append(board.main.iframe, placeholder, overlayLayer);
    world.append(root);
    labels.append(label);
    sizeBoard(board);
    return board;
  };

  const sizeBoard = (board: Board): void => {
    const { rect } = board.art;
    board.root.style.transform = `translate(${rect.x}px, ${rect.y}px)`;
    board.root.style.width = `${rect.w}px`;
    board.root.style.height = `${rect.h}px`;
    for (const slot of [board.main, board.compare]) {
      if (!slot) continue;
      slot.iframe.style.width = `${rect.w}px`;
      slot.iframe.style.height = `${rect.h}px`;
    }
    placeLabel(board);
  };

  const ensureCompare = (board: Board): FrameSlot => {
    if (board.compare) return board.compare;
    const slot = createFrameSlot({
      slug: options.slug,
      artboardId: board.art.id,
      title: `${board.art.screen?.title ?? detail.design.title} (saved version)`,
      mode: () => 'play',
      scroll: () => board.scroll,
      onState: () => paint(board),
    });
    slot.iframe.classList.add('dc-frame-compare');
    board.compare = slot;
    board.root.insertBefore(slot.iframe, board.placeholder);
    sizeBoard(board);
    return slot;
  };

  const dropCompare = (board: Board): void => {
    board.compare?.dispose();
    board.compare = null;
  };

  const disposeBoard = (board: Board): void => {
    board.tracker.dispose();
    board.main.dispose();
    board.compare?.dispose();
    board.root.remove();
    board.label.remove();
  };

  const rebuildLayout = (): void => {
    const visible = override ? [override] : detail.design.viewports.filter((viewport) => !hidden.has(viewport.id));
    const { design } = detail;
    const rows = design.kind === 'artifact' ? [{ id: null, title: design.title }] : design.screens.map((screen) => ({ id: screen.id, title: screen.title, ...(screen.viewports ? { viewports: screen.viewports } : {}) }));
    const wall = layoutWall(rows, visible);
    layout = {
      boards: wall.artboards.map((cell) => ({
        id: cell.id,
        screen: cell.screen === null ? null : (design.screens.find((screen) => screen.id === cell.screen) ?? null),
        viewport: cell.viewport,
        rect: toRect(cell.frame),
        cell,
      })),
      bounds: wall.bounds ? toRect(wall.bounds) : { x: 0, y: 0, w: 0, h: 0 },
    };
    const keep = new Set(layout.boards.map((art) => art.id));
    for (const [id, board] of boards) {
      if (!keep.has(id)) {
        if (popover?.board === board) closePopover();
        disposeBoard(board);
        boards.delete(id);
      }
    }
    for (const art of layout.boards) {
      const existing = boards.get(art.id);
      if (existing) {
        const resized = existing.art.rect.w !== art.rect.w || existing.art.rect.h !== art.rect.h;
        existing.art = art;
        sizeBoard(existing);
        if (resized) void loadBoard(existing);
      } else boards.set(art.id, makeBoard(art));
    }
    for (const board of boards.values()) paint(board);
  };

  // ---------------------------------------------------------------- loading

  const loadBoard = async (board: Board): Promise<void> => {
    if (!board.live) return;
    const file = fileOf(board.screenId);
    // Pins belong to the artboard's own screen: none while play mode shows another one.
    board.tracker.setComments(board.screenId === (board.art.screen?.id ?? null) ? commentsOf(board.art) : []);
    paint(board);
    const tasks = [board.main.load(board.screenId, compare ? null : version, file)];
    if (compare && version !== null) tasks.push(ensureCompare(board).load(board.screenId, version, file));
    else dropCompare(board);
    board.root.dataset.compare = compare && version !== null ? 'true' : 'false';
    await Promise.all(tasks);
    paint(board);
  };

  const syncLive = (): void => {
    syncQueued = false;
    if (disposed || surfaceSize.w === 0) return;
    const live = new Set(liveBoards([...boards.values()].map((board) => ({ id: board.art.id, rect: board.art.rect })), camera, surfaceSize, liveBudget, FRAME_UNLOAD_MARGIN).map((entry) => entry.id));
    for (const board of boards.values()) {
      const shouldLive = live.has(board.art.id);
      if (shouldLive && !board.live) {
        board.live = true;
        paint(board);
        if (board.main.state() === 'idle') void loadBoard(board);
      } else if (!shouldLive && board.live) {
        board.live = false;
        board.main.unload();
        board.compare?.unload();
        board.placements = [];
        paint(board);
      }
    }
  };

  const queueSync = (): void => {
    if (syncQueued) return;
    syncQueued = true;
    requestAnimationFrame(syncLive);
  };

  const resetBoard = (board: Board): void => {
    board.screenId = board.art.screen?.id ?? null;
    board.scroll = { x: 0, y: 0 };
    void loadBoard(board);
  };

  // ---------------------------------------------------------------- hover, pins, popovers

  function closePopover(): void {
    if (!popover) return;
    const current = popover;
    popover = null;
    current.card.el.remove();
    current.board.selected.hidden = true;
    for (const pin of current.board.pins.values()) pin.removeAttribute('aria-expanded');
    document.querySelector('.dc-temp-pin')?.remove();
  }

  function clearHover(): void {
    for (const board of boards.values()) board.hover.hidden = true;
    hoveredBoard = null;
  }

  const rectToBox = (board: Board, el: HTMLElement, rect: { x: number; y: number; w: number; h: number }): void => {
    el.style.left = `${rect.x - board.scroll.x}px`;
    el.style.top = `${rect.y - board.scroll.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
  };

  const placeCard = (card: HTMLElement, anchorScreen: Point, below: number): void => {
    overlay.append(card);
    const width = Math.min(card.offsetWidth, surfaceSize.w - 16);
    const height = card.offsetHeight;
    let left = anchorScreen.x;
    let top = anchorScreen.y + below + 10;
    if (left + width > surfaceSize.w - 8) left = surfaceSize.w - width - 8;
    if (top + height > surfaceSize.h - 8) top = Math.max(8, anchorScreen.y - height - 10);
    card.style.left = `${Math.max(8, left)}px`;
    card.style.top = `${Math.max(8, top)}px`;
  };

  /** Where a comment's pin sits (frame px) and what its anchor resolved to, from the board's pin tracker. */
  const pinState = (board: Board, comment: Comment): { point: Point; anchorState: 'exact' | 'moved' | 'detached' | 'unknown' } => {
    const placement = board.placements.find((entry) => entry.commentId === comment.id);
    if (!placement) return { point: pinFramePoint(comment.anchor.rect, comment.anchor.point, board.scroll), anchorState: 'unknown' };
    return { point: docToFrame(placement.point, board.scroll), anchorState: placement.state === 'pending' ? 'unknown' : placement.state };
  };

  const placePin = (el: HTMLElement, at: Point): void => {
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
  };

  /** Zoom in on a folded group of pins until they come apart (from 100 % they fan out instead). */
  const openCluster = (board: Board, spots: PinSpot[], anchor: Point): void => {
    const target = separatingScale(spots, camera.scale, pinSize());
    setCamera(zoomAt(camera, target, frameToScreen(camera, board.art.rect, anchor)), true);
  };

  /**
   * Pins keep one screen size at every zoom, so neighbours collide when zoomed out. Pins closer
   * than a pin's width fold into one count badge (click: zoom in); from 100 % up, pins that still
   * share a spot fan out into a row. Pins scrolled out of the frame are hidden.
   */
  const paintPins = (board: Board): void => {
    const show = !readOnly() && (mode === 'edit' || showPins);
    board.overlay.dataset.pins = show ? 'shown' : 'hidden';
    const nums = numbers();
    const mine = commentsOf(board.art).sort((a, b) => (nums.get(a.id) ?? 0) - (nums.get(b.id) ?? 0));
    const keep = new Set(mine.map((comment) => comment.id));
    for (const [id, pin] of board.pins) {
      if (!keep.has(id)) {
        pin.remove();
        board.pins.delete(id);
      }
    }
    for (const cluster of board.clusters) cluster.remove();
    board.clusters = [];

    const frameSize = { width: board.art.rect.w, height: board.art.rect.h };
    const spots: PinSpot[] = [];
    for (const comment of mine) {
      let pin = board.pins.get(comment.id);
      if (!pin) {
        const created = h('button', { type: 'button', class: 'dc-pin' });
        created.addEventListener('pointerdown', (event) => event.stopPropagation());
        created.addEventListener('click', (event) => {
          event.stopPropagation();
          openThread(board, comment.id);
        });
        board.overlay.append(created);
        board.pins.set(comment.id, created);
        pin = created;
      }
      const number = nums.get(comment.id) ?? 0;
      const { point, anchorState } = pinState(board, comment);
      pin.textContent = pinGlyph(comment, number);
      pin.dataset.status = comment.status;
      pin.dataset.detached = anchorState === 'detached' ? 'true' : 'false';
      pin.setAttribute('aria-label', `${pinAriaLabel(comment, number)}${anchorState === 'detached' ? ', element not found' : ''}`);
      const inView = isInFrameView({ x: point.x + board.scroll.x, y: point.y + board.scroll.y }, board.scroll, frameSize);
      pin.hidden = !inView;
      pin.tabIndex = show ? 0 : -1;
      placePin(pin, point);
      if (inView) spots.push({ id: comment.id, x: point.x, y: point.y });
    }

    for (const group of clusterPins(spots, camera.scale, pinSize())) {
      if (group.ids.length === 1) continue;
      const members = spots.filter((spot) => group.ids.includes(spot.id));
      if (camera.scale >= PIN_FAN_SCALE) {
        for (const spot of fanOut(group, camera.scale, pinSize())) {
          const pin = board.pins.get(spot.id);
          if (pin) placePin(pin, spot);
        }
        continue;
      }
      for (const id of group.ids) {
        const pin = board.pins.get(id);
        if (pin) pin.hidden = true;
      }
      const labels = group.ids.map((id) => nums.get(id) ?? 0).join(', ');
      const statuses = new Set(group.ids.map((id) => comments().find((comment) => comment.id === id)?.status));
      const cluster = h('button', {
        type: 'button',
        class: 'dc-pin dc-pin-cluster',
        'data-status': statuses.has('open') ? 'open' : statuses.has('sent') ? 'sent' : 'resolved',
        'aria-label': `${group.ids.length} comments here (${labels}). Zoom in to see them.`,
        title: `Comments ${labels} — click to zoom in`,
      }, String(group.ids.length));
      cluster.tabIndex = show ? 0 : -1;
      cluster.addEventListener('pointerdown', (event) => event.stopPropagation());
      cluster.addEventListener('click', (event) => {
        event.stopPropagation();
        openCluster(board, members, group);
      });
      placePin(cluster, group);
      board.overlay.append(cluster);
      board.clusters.push(cluster);
    }
  };

  const openThread = (board: Board, commentId: string): void => {
    const comment = comments().find((candidate) => candidate.id === commentId);
    if (!comment) return;
    closePopover();
    const number = numbers().get(commentId) ?? 0;
    const { point, anchorState } = pinState(board, comment);
    const card = createThread({
      comment,
      number,
      where: `${board.art.screen?.title ?? 'Artifact'} · ${board.art.viewport.label}`,
      anchorState,
      readOnly: readOnly(),
      onSave: async (body) => {
        await options.updateComment(commentId, { body });
        closePopover();
      },
      onStatus: async (status) => {
        await options.updateComment(commentId, { status });
        closePopover();
      },
      onDelete: async () => {
        await options.deleteComment(commentId);
        closePopover();
      },
      onClose: () => closePopover(),
    });
    popover = { card, close: closePopover, board, commentId };
    const screenPoint = frameToScreen(camera, board.art.rect, point);
    placeCard(card.el, { x: screenPoint.x + 14, y: screenPoint.y - 10 }, 0);
    board.pins.get(commentId)?.setAttribute('aria-expanded', 'true');
    card.focus();
  };

  const openComposer = (board: Board, element: HitElement, framePoint: Point): void => {
    closePopover();
    const anchor = anchorFromHit(element, framePoint, board.scroll);
    const { point } = anchor;
    rectToBox(board, board.selected, element.rect);
    board.selected.hidden = false;
    board.hover.hidden = true;
    const temp = h('span', { class: 'dc-pin dc-temp-pin', 'aria-hidden': 'true' }, '+');
    const pinAt = pinFramePoint(element.rect, point, board.scroll);
    temp.style.left = `${pinAt.x}px`;
    temp.style.top = `${pinAt.y}px`;
    board.overlay.append(temp);
    const card = createComposer({
      tag: element.tag,
      snippet: element.text.length > 80 ? `${element.text.slice(0, 77)}…` : element.text,
      onCancel: () => closePopover(),
      onSubmit: async (body) => {
        await options.createComment({
          screen: board.art.screen?.id ?? null,
          viewport: board.art.viewport.id,
          anchor,
          body,
        });
        closePopover();
      },
    });
    popover = { card, close: closePopover, board, commentId: null };
    const base = frameToScreen(camera, board.art.rect, { x: element.rect.x - board.scroll.x, y: element.rect.y - board.scroll.y });
    placeCard(card.el, base, element.rect.h * camera.scale);
    card.focus();
  };

  const requestHit = (board: Board, frame: Point, purpose: 'hover' | 'click'): void => {
    if (board.main.state() !== 'ready') return;
    pendingHit = { board, frame, purpose };
    board.main.post({ type: 'hit-test', x: frame.x, y: frame.y });
  };

  const onHit = (board: Board, message: Extract<FrameToPageMessage, { type: 'hit' }>): void => {
    const request = pendingHit;
    if (!request || request.board !== board || request.frame.x !== message.x || request.frame.y !== message.y) return;
    if (request.purpose === 'click') {
      pendingHit = null;
      if (override) options.onNotice('Comments attach to a device size. Pick one of the sizes in the list to comment.');
      else if (message.element) openComposer(board, message.element, request.frame);
      else options.onNotice('There is no element there to comment on.');
      return;
    }
    if (hoveredBoard !== board || popover) return;
    if (!message.element) {
      board.hover.hidden = true;
      return;
    }
    rectToBox(board, board.hover, message.element.rect);
    board.hoverTag.textContent = message.element.tag;
    board.hover.hidden = false;
  };

  const scheduleHover = (): void => {
    if (hoverTimer) return;
    hoverTimer = requestAnimationFrame(() => {
      hoverTimer = 0;
      if (!pointer || mode !== 'edit' || readOnly() || popover || panning) return;
      const now = performance.now();
      if (now - lastHitAt < HOVER_MIN_INTERVAL) return scheduleHover();
      lastHitAt = now;
      const board = boardAt(camera, [...boards.values()].map((entry) => ({ rect: entry.art.rect, board: entry })), pointer.point)?.board ?? null;
      if (hoveredBoard && hoveredBoard !== board) hoveredBoard.hover.hidden = true;
      hoveredBoard = board;
      if (board) requestHit(board, screenToFrame(camera, board.art.rect, pointer.point), 'hover');
    });
  };

  // ---------------------------------------------------------------- frame messages

  const handleMessage = (board: Board, message: FrameToPageMessage): void => {
    switch (message.type) {
      case 'ready':
        board.main.post({ type: 'set-mode', mode: readOnly() ? 'play' : mode });
        return;
      case 'scroll':
        // The pin tracker repaints the pins; a card anchored to the old position closes.
        if (popover?.board === board) closePopover();
        return;
      case 'hit':
        onHit(board, message);
        return;
      case 'navigate': {
        const target = screens().find((candidate) => candidate.file === message.href);
        if (!target) {
          options.onNotice('That link doesn’t lead to a screen of this design.');
          return;
        }
        board.screenId = target.id;
        board.scroll = { x: 0, y: 0 };
        void loadBoard(board);
        return;
      }
      case 'open-external':
        options.onExternal(message.url);
        return;
      case 'wheel': {
        const at = frameToScreen(camera, board.art.rect, { x: message.x, y: message.y });
        if (message.ctrl) setCamera(wheelZoom(camera, message.deltaY, at), true);
        // A plain wheel reaches us only from Edit mode: scroll the design, as over the wall.
        else if (mode === 'edit' && !readOnly()) board.main.post({ type: 'scroll-by', dx: message.deltaX, dy: message.deltaY });
        else setCamera(panBy(camera, -message.deltaX, -message.deltaY), true);
        return;
      }
      case 'key':
        // Space is a hold-to-pan key on the wall itself; a frame only sends key-down, so it would stick.
        if (message.key !== ' ') shortcut(message.key, message.shift);
        return;
      default:
        // `size` and `anchors` feed the pin tracker.
        return;
    }
  };

  // ---------------------------------------------------------------- input

  const zoomAtCentre = (factor: number): void => {
    const centre = { x: surfaceSize.w / 2, y: surfaceSize.h / 2 };
    setCamera(zoomAt(camera, camera.scale * factor, centre), true);
  };

  const zoomReset = (): void => {
    const centre = { x: surfaceSize.w / 2, y: surfaceSize.h / 2 };
    setCamera(zoomAt(camera, 1, centre), true);
  };

  function shortcut(key: string, shift: boolean): boolean {
    if (key === 'Escape') {
      if (!popover) return false;
      closePopover();
      return true;
    }
    if (key === '+' || key === '=') zoomAtCentre(1.25);
    else if (key === '-' || key === '_') zoomAtCentre(1 / 1.25);
    else if (key === '0' && shift) zoomReset();
    else if (key === '1' && shift) fit();
    else if (key === ' ') spaceDown = true;
    else return false;
    surface.dataset.tool = spaceDown || panTool ? 'pan' : 'none';
    return true;
  }

  scope.listen<KeyboardEvent>(surface, 'keydown', (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const step = nudgeStep(event.shiftKey);
    const code = event.code;
    let handled = true;
    if (code === 'Digit0' && event.shiftKey) zoomReset();
    else if (code === 'Digit1' && event.shiftKey) fit();
    else if (event.key === 'ArrowLeft') setCamera(panBy(camera, step, 0), true);
    else if (event.key === 'ArrowRight') setCamera(panBy(camera, -step, 0), true);
    else if (event.key === 'ArrowUp') setCamera(panBy(camera, 0, step), true);
    else if (event.key === 'ArrowDown') setCamera(panBy(camera, 0, -step), true);
    else if (event.key.toLowerCase() === 'h') {
      panTool = !panTool;
      surface.dataset.tool = panTool || spaceDown ? 'pan' : 'none';
    } else if (event.key === ' ' || event.key === '+' || event.key === '=' || event.key === '-' || event.key === 'Escape') handled = shortcut(event.key, event.shiftKey);
    else handled = false;
    if (handled) event.preventDefault();
  });
  scope.listen<KeyboardEvent>(surface, 'keyup', (event) => {
    if (event.key === ' ') {
      spaceDown = false;
      surface.dataset.tool = panTool ? 'pan' : 'none';
    }
  });

  scope.listen<WheelEvent>(
    surface,
    'wheel',
    (event) => {
      const at = local(event);
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        setCamera(wheelZoom(camera, event.deltaY, at), true);
        return;
      }
      const board = boardAt(camera, [...boards.values()].map((entry) => ({ rect: entry.art.rect, board: entry })), at)?.board;
      if (mode === 'edit' && !readOnly() && board && !spaceDown && !panTool && board.main.state() === 'ready') {
        event.preventDefault();
        board.main.post({ type: 'scroll-by', dx: event.deltaX, dy: event.deltaY });
        return;
      }
      event.preventDefault();
      setCamera(panBy(camera, -event.deltaX, -event.deltaY), true);
    },
    { passive: false },
  );

  let downAt: { point: Point; board: Board | null } | null = null;

  scope.listen<PointerEvent>(surface, 'pointerdown', (event) => {
    if (event.target instanceof Element && event.target.closest('.dc-pop, .dc-label, .dc-pin')) return;
    surface.focus({ preventScroll: true });
    const at = local(event);
    const board = boardAt(camera, [...boards.values()].map((entry) => ({ rect: entry.art.rect, board: entry })), at)?.board ?? null;
    const wantsPan = event.button === 1 || spaceDown || panTool || board === null || mode === 'play' || readOnly();
    if (event.button !== 0 && event.button !== 1) return;
    if (popover) closePopover();
    if (wantsPan) {
      panning = { id: event.pointerId, last: at };
      surface.setPointerCapture(event.pointerId);
      surface.dataset.panning = 'true';
      event.preventDefault();
    } else downAt = { point: at, board };
  });

  scope.listen<PointerEvent>(surface, 'pointermove', (event) => {
    const at = local(event);
    pointer = { point: at };
    if (panning && panning.id === event.pointerId) {
      setCamera(panBy(camera, at.x - panning.last.x, at.y - panning.last.y), true);
      panning.last = at;
      return;
    }
    if (downAt && Math.hypot(at.x - downAt.point.x, at.y - downAt.point.y) > 4) {
      // A drag that started on an artboard in Edit mode pans the wall instead of commenting.
      panning = { id: event.pointerId, last: downAt.point };
      downAt = null;
      surface.setPointerCapture(event.pointerId);
      surface.dataset.panning = 'true';
      clearHover();
      return;
    }
    scheduleHover();
  });

  const endPointer = (event: PointerEvent): void => {
    if (panning && panning.id === event.pointerId) {
      panning = null;
      delete surface.dataset.panning;
      return;
    }
    const press = downAt;
    downAt = null;
    if (press && press.board && event.type === 'pointerup' && mode === 'edit' && !readOnly()) {
      requestHit(press.board, screenToFrame(camera, press.board.art.rect, press.point), 'click');
    }
  };
  scope.listen<PointerEvent>(surface, 'pointerup', endPointer);
  scope.listen<PointerEvent>(surface, 'pointercancel', endPointer);
  scope.listen<PointerEvent>(surface, 'pointerleave', () => {
    pointer = null;
    clearHover();
  });

  scope.listen<MouseEvent>(labels, 'dblclick', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('.dc-label') : null;
    if (!target) return;
    for (const board of boards.values()) {
      if (board.label === target) setCamera(focusArtboard(board.art.cell, size(), { padding: options.compact ? 12 : 64 }), true);
    }
  });

  // ---------------------------------------------------------------- lifecycle

  const observer = new ResizeObserver(() => {
    const rect = surfaceRect();
    surfaceSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
    if (surfaceSize.w === 0 || surfaceSize.h === 0) return;
    if (!userMoved) camera = fitView();
    applyCamera();
  });
  observer.observe(surface);
  scope.add(() => observer.disconnect());

  rebuildLayout();
  applyCamera();

  /** New comments or edits: the trackers re-ask the frames when the set of comments changed. */
  const paintAllPins = (): void => {
    for (const board of boards.values()) {
      board.tracker.setComments(board.screenId === (board.art.screen?.id ?? null) ? commentsOf(board.art) : []);
      paintPins(board);
    }
  };

  return {
    el: surface,
    setDetail: (next) => {
      const structureChanged =
        JSON.stringify(next.design.screens) !== JSON.stringify(detail.design.screens) || JSON.stringify(next.design.viewports) !== JSON.stringify(detail.design.viewports) || next.design.kind !== detail.design.kind;
      detail = next;
      if (structureChanged) {
        rebuildLayout();
        if (!userMoved && surfaceSize.w > 0) camera = fitView();
        applyCamera();
      }
      paintAllPins();
      for (const board of boards.values()) paintLabel(board);
    },
    setMode: (next) => {
      if (next === mode) return;
      mode = next;
      surface.dataset.mode = mode;
      closePopover();
      clearHover();
      for (const board of boards.values()) {
        if (mode === 'edit' && board.screenId !== (board.art.screen?.id ?? null)) resetBoard(board);
        board.main.post({ type: 'set-mode', mode: readOnly() ? 'play' : mode });
        paintPins(board);
      }
    },
    setHiddenViewports: (ids) => {
      hidden = new Set(ids);
      rebuildLayout();
      if (!userMoved) camera = fitView();
      applyCamera();
    },
    setVersion: (next, nextCompare) => {
      version = next;
      compare = nextCompare && next !== null;
      surface.dataset.readonly = readOnly() ? 'true' : 'false';
      closePopover();
      for (const board of boards.values()) {
        board.screenId = board.art.screen?.id ?? null;
        board.scroll = { x: 0, y: 0 };
        if (board.live) void loadBoard(board);
        paintPins(board);
      }
    },
    setViewportOverride: (next) => {
      override = next;
      rebuildLayout();
      if (!userMoved && surfaceSize.w > 0) camera = fitView();
      applyCamera();
    },
    externalRefs: () => [...new Set([...boards.values()].flatMap((board) => board.main.meta()?.external ?? []))],
    detachedIds: () => {
      const ids = new Set<string>();
      for (const board of boards.values()) if (board.live) for (const placement of board.placements) if (placement.state === 'detached') ids.add(placement.commentId);
      return ids;
    },
    anchorStates: () => anchorStatesOf([...boards.values()].filter((board) => board.live).flatMap((board) => board.placements)),
    setShowPins: (show) => {
      showPins = show;
      for (const board of boards.values()) paintPins(board);
    },
    reload: (sources) => {
      for (const board of boards.values()) {
        const state = board.main.state();
        const affected = sources === undefined || sources.has(board.art.screen?.id ?? null) || state === 'missing' || state === 'error';
        if (affected && board.live) void loadBoard(board);
      }
    },
    zoomStep: zoomAtCentre,
    zoomReset,
    fit,
    refit: () => {
      if (userMoved || surfaceSize.w === 0) return;
      camera = fitView();
      applyCamera();
    },
    getCamera: () => camera,
    focusComment: (id) => {
      const comment = comments().find((candidate) => candidate.id === id);
      if (!comment) return;
      const board = layout.boards.map((art) => boards.get(art.id)).find((candidate) => candidate && candidate.art.screen?.id === (comment.screen ?? undefined) && candidate.art.viewport.id === comment.viewport) ?? [...boards.values()].find((candidate) => comment.screen === null && candidate.art.viewport.id === comment.viewport);
      if (!board) return;
      setCamera(focusArtboard(board.art.cell, size(), { padding: options.compact ? 12 : 64 }), true);
      setTimeout(() => {
        if (!disposed) openThread(board, id);
      }, 120);
    },
    focus: () => surface.focus({ preventScroll: true }),
    dispose: () => {
      disposed = true;
      closePopover();
      clearTimeout(settleTimer);
      cancelAnimationFrame(hoverTimer);
      scope.dispose();
      for (const board of boards.values()) disposeBoard(board);
      boards.clear();
      surface.remove();
    },
  };
};
