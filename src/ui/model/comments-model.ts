// View-model of the comments drawer (P3) and the pins on the wall.

import type { Comment, CommentStatus, Screen, Viewport } from '../../shared/types.ts';
import { viewportLabel } from './format.ts';

export type CommentFilter = CommentStatus;

export const COMMENT_FILTERS: ReadonlyArray<{ id: CommentFilter; label: string }> = [
  { id: 'open', label: 'Open' },
  { id: 'sent', label: 'Sent' },
  { id: 'resolved', label: 'Resolved' },
];

export const statusLabel = (status: CommentStatus): string => (status === 'open' ? 'Open' : status === 'sent' ? 'Sent to chat' : 'Resolved');

/**
 * Pin numbers: 1.. in creation order across the whole design, stable when other comments
 * are resolved or deleted later than this one. Ties keep array order.
 */
export const pinNumbers = (comments: readonly Comment[]): Map<string, number> => {
  const ordered = comments
    .map((comment, index) => ({ comment, index }))
    .sort((a, b) => Date.parse(a.comment.created) - Date.parse(b.comment.created) || a.index - b.index);
  const numbers = new Map<string, number>();
  ordered.forEach(({ comment }, position) => numbers.set(comment.id, position + 1));
  return numbers;
};

export type CommentGroup = { key: string; title: string; comments: Comment[] };

/** Drawer groups: one per screen in wall order, then comments whose screen no longer exists. Artifacts have one group. */
export const groupComments = (comments: readonly Comment[], screens: readonly Screen[], artifactTitle: string): CommentGroup[] => {
  const groups: CommentGroup[] = [];
  const known = new Set<string>();
  const artifact = comments.filter((comment) => comment.screen === null);
  if (artifact.length > 0) groups.push({ key: 'artifact', title: artifactTitle, comments: artifact });
  for (const screen of screens) {
    known.add(screen.id);
    const mine = comments.filter((comment) => comment.screen === screen.id);
    if (mine.length > 0) groups.push({ key: screen.id, title: screen.title, comments: mine });
  }
  const orphans = comments.filter((comment) => comment.screen !== null && !known.has(comment.screen));
  if (orphans.length > 0) groups.push({ key: '__missing', title: 'Screens that no longer exist', comments: orphans });
  return groups;
};

export const countByStatus = (comments: readonly Comment[]): Record<CommentStatus, number> => ({
  open: comments.filter((comment) => comment.status === 'open').length,
  sent: comments.filter((comment) => comment.status === 'sent').length,
  resolved: comments.filter((comment) => comment.status === 'resolved').length,
});

export const viewportOf = (viewports: readonly Viewport[], id: string): string => {
  const viewport = viewports.find((candidate) => candidate.id === id);
  return viewport ? viewportLabel(viewport) : id;
};

export type SendState = { enabled: boolean; label: string; reason: string | null };

/** The drawer footer button: what it says, and — when disabled — why. */
export const sendState = (comments: readonly Comment[], linked: boolean): SendState => {
  const open = comments.filter((comment) => comment.status === 'open').length;
  if (open === 0) return { enabled: false, label: 'Send comments to chat', reason: 'Add a comment on the canvas first, or reopen a resolved one.' };
  const noun = open === 1 ? 'comment' : 'comments';
  return { enabled: true, label: `Send ${open} ${noun} to chat`, reason: linked ? null : 'No chat is linked yet — a new chat will start.' };
};

/** Pin glyph: the number while the comment is live, a check once resolved. */
export const pinGlyph = (comment: Comment, number: number): string => (comment.status === 'resolved' ? '✓' : String(number));

/** Pin accessible name: "Comment 3: Make this shorter (open)". */
export const pinAriaLabel = (comment: Comment, number: number): string => {
  const body = comment.body.length > 60 ? `${comment.body.slice(0, 57)}…` : comment.body;
  return `Comment ${number}: ${body} (${statusLabel(comment.status).toLowerCase()})`;
};
