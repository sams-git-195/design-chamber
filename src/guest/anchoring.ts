// Page-side pin placement (docs/SPEC.md §8.2, §8.3, §13.2 P2). The bridge resolves each stored
// anchor inside the frame and reports a rect in document px; this module turns those reports
// into pin positions and decides which pins are detached.
//
// Coordinate chain: document px (bridge) − frame scroll = frame px; + artboard frame origin =
// wall (world) px; camera (`camera.ts`) = screen px.

import type { AnchorQuery, AnchorResult, HitElement } from '../shared/bridge-protocol.ts';
import type { AnchorState, Comment, CommentAnchor, Rect, RelPoint } from '../shared/types.ts';
import type { Box, Point, Size } from './camera.ts';
import type { FrameChannel } from './frame-channel.ts';

/** `pending`: no answer from the frame yet (drawn at the stored rect); `moved`: matched by text. */
export type PinState = 'pending' | 'exact' | 'moved' | 'detached';

export type PinPlacement = {
  commentId: string;
  state: PinState;
  /** Element rect in document px: the live one, or the stored one when pending/detached. */
  rect: Rect;
  /** The pin itself in document px. */
  point: Point;
};

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0.5);

export const pinPoint = (rect: Rect, relative: RelPoint): Point => ({
  x: rect.x + clamp01(relative.x) * rect.w,
  y: rect.y + clamp01(relative.y) * rect.h,
});

/** The comments drawn on one artboard (artifact: `screen` null). */
export const commentsForArtboard = (comments: readonly Comment[], screen: string | null, viewport: string): Comment[] =>
  comments.filter((comment) => comment.screen === screen && comment.viewport === viewport);

export const anchorQueriesOf = (comments: readonly Comment[]): AnchorQuery[] =>
  comments.map((comment) => ({ id: comment.id, selector: comment.anchor.selector, text: comment.anchor.text, html: comment.anchor.html }));

const stateOf = (result: AnchorResult | undefined): PinState => {
  if (!result) return 'pending';
  if (!result.found || !result.rect) return 'detached';
  return result.exact ? 'exact' : 'moved';
};

/** Pins for `comments` from the frame's `anchors` results (null before the first answer). */
export const placePins = (comments: readonly Comment[], results: readonly AnchorResult[] | null): PinPlacement[] => {
  const byId = new Map((results ?? []).map((result) => [result.id, result]));
  return comments.map((comment) => {
    const result = byId.get(comment.id);
    const state = stateOf(result);
    const rect = (state === 'exact' || state === 'moved') && result?.rect ? result.rect : comment.anchor.rect;
    return { commentId: comment.id, state, rect, point: pinPoint(rect, comment.anchor.point) };
  });
};

export const isDetached = (placement: PinPlacement): boolean => placement.state === 'detached';

/**
 * What "send comments" tells the service about each pin (`POST /designs/:slug/prompt`
 * `anchorStates`), so the revision prompt flags moved or missing elements. Pins the frame has
 * not answered for yet (`pending`) carry no flag.
 */
export const anchorStatesOf = (placements: Iterable<PinPlacement>): Record<string, AnchorState> => {
  const states: Record<string, AnchorState> = {};
  for (const placement of placements) {
    if (placement.state !== 'pending') states[placement.commentId] = placement.state;
  }
  return states;
};

/** Document px → frame px. */
export const docToFrame = (point: Point, scroll: Point): Point => ({ x: point.x - scroll.x, y: point.y - scroll.y });

/** Document px → wall (world) px for an artboard whose frame box is `frame`. */
export const docToWall = (point: Point, scroll: Point, frame: Box): Point => {
  const inFrame = docToFrame(point, scroll);
  return { x: frame.x + inFrame.x, y: frame.y + inFrame.y };
};

/** Whether a document point is inside the frame's visible area (pins outside are hidden). */
export const isInFrameView = (point: Point, scroll: Point, frameSize: Size): boolean => {
  const inFrame = docToFrame(point, scroll);
  return inFrame.x >= 0 && inFrame.y >= 0 && inFrame.x <= frameSize.width && inFrame.y <= frameSize.height;
};

/**
 * The anchor for a new comment: the bridge's `hit` element plus where the user clicked
 * (frame px, `scroll` = the frame scroll at the click), stored as a relative point.
 */
export const anchorFromHit = (hit: HitElement, click: Point, scroll: Point): CommentAnchor => {
  const docX = click.x + scroll.x;
  const docY = click.y + scroll.y;
  return {
    selector: hit.selector,
    text: hit.text,
    html: hit.html,
    rect: hit.rect,
    point: {
      x: hit.rect.w > 0 ? clamp01((docX - hit.rect.x) / hit.rect.w) : 0.5,
      y: hit.rect.h > 0 ? clamp01((docY - hit.rect.y) / hit.rect.h) : 0.5,
    },
  };
};

// ---- Live tracking for one artboard frame ----

export type PinTracker = {
  /** Replace the comments drawn on this artboard; re-asks the frame. */
  setComments(comments: readonly Comment[]): void;
  placements(): PinPlacement[];
  /** Last frame scroll (document px of the frame's top-left). */
  scroll(): Point;
  /** Called with fresh placements on every anchors answer, scroll or comment change. */
  subscribe(listener: (placements: PinPlacement[], scroll: Point) => void): () => void;
  dispose(): void;
};

/**
 * Keeps pins in step with one frame: asks `resolve-anchors` on `ready`, on every `size` change
 * (content reflowed) and when the comments change; follows `scroll`. Answers to an older
 * question are dropped by comparing the ids asked.
 */
export const trackPins = (channel: FrameChannel, initial: readonly Comment[] = []): PinTracker => {
  let comments: readonly Comment[] = initial;
  let results: AnchorResult[] | null = null;
  let scroll: Point = { x: 0, y: 0 };
  let askedIds = '';
  let ready = false;
  const listeners = new Set<(placements: PinPlacement[], scroll: Point) => void>();

  const emit = (): void => {
    const placements = placePins(comments, results);
    for (const listener of [...listeners]) listener(placements, scroll);
  };

  const ask = (): void => {
    if (!ready) return;
    askedIds = comments.map((comment) => comment.id).join(',');
    if (comments.length === 0) {
      results = [];
      emit();
      return;
    }
    channel.send({ type: 'resolve-anchors', anchors: anchorQueriesOf(comments) });
  };

  const unsubscribe = channel.subscribe((message) => {
    switch (message.type) {
      case 'ready':
        ready = true;
        ask();
        return;
      case 'size':
        // A size report also proves the bridge is up (a tracker created after `ready`).
        ready = true;
        ask();
        return;
      case 'scroll':
        scroll = { x: message.x, y: message.y };
        emit();
        return;
      case 'anchors':
        if (message.results.map((result) => result.id).join(',') !== askedIds) return;
        results = message.results;
        emit();
        return;
      default:
        return;
    }
  });

  return {
    setComments: (next) => {
      const sameAnchors = next.map((comment) => comment.id).join(',') === comments.map((comment) => comment.id).join(',');
      comments = next;
      if (sameAnchors) {
        emit();
        return;
      }
      results = null;
      emit();
      ask();
    },
    placements: () => placePins(comments, results),
    scroll: () => scroll,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: () => {
      listeners.clear();
      unsubscribe();
    },
  };
};
