// WP1 — POST /designs/:slug/comments, PATCH /designs/:slug/comments/:id, DELETE /designs/:slug/comments/:id, POST /designs/:slug/comments/mark-sent (docs/SPEC.md §7, §6.2).

import type {
  CommentResponse,
  CreateCommentBody,
  MarkSentBody,
  MarkSentResponse,
  OkResponse,
  PatchCommentBody,
} from '../../shared/api.ts';
import { parseCommentAnchor } from '../../shared/design-json.ts';
import {
  COMMENT_BODY_MAX,
  COMMENT_ID_PATTERN,
  COMMENTS_MAX,
  SCREEN_ID_PATTERN,
  VIEWPORT_ID_PATTERN,
} from '../../shared/limits.ts';
import type { CommentStatus } from '../../shared/types.ts';
import type { ServiceContext } from '../context.ts';
import { ApiError, type Router } from '../http.ts';

const isBodyRecord = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body);

const COMMENT_STATUSES: readonly CommentStatus[] = ['open', 'sent', 'resolved'];

const validateCreate = (body: unknown): CreateCommentBody => {
  if (!isBodyRecord(body)) throw new ApiError('bad-request', 'The comment must be a JSON object.');
  const { screen, viewport, body: text } = body;
  if (screen !== null && (typeof screen !== 'string' || !SCREEN_ID_PATTERN.test(screen))) {
    throw new ApiError('bad-request', 'The comment belongs to a screen id (lowercase letters, digits and -), or null on an artifact.');
  }
  if (typeof viewport !== 'string' || !VIEWPORT_ID_PATTERN.test(viewport)) {
    throw new ApiError('bad-request', 'The comment needs the viewport id it was made on.');
  }
  const anchor = parseCommentAnchor(body.anchor);
  if (anchor === null) throw new ApiError('bad-request', 'The element anchor (selector, text, html, rect, point) is not valid.');
  if (typeof text !== 'string' || text.trim().length < 1 || text.length > COMMENT_BODY_MAX) {
    throw new ApiError('bad-request', `The comment text must be 1–${COMMENT_BODY_MAX} characters.`);
  }
  return { screen, viewport, anchor, body: text };
};

const validatePatch = (body: unknown): PatchCommentBody => {
  if (!isBodyRecord(body)) throw new ApiError('bad-request', 'The comment update must be a JSON object.');
  const patch: PatchCommentBody = {};
  let fields = 0;
  if (body.body !== undefined) {
    if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.length > COMMENT_BODY_MAX) {
      throw new ApiError('bad-request', `The comment text must be 1–${COMMENT_BODY_MAX} characters.`);
    }
    patch.body = body.body;
    fields += 1;
  }
  if (body.status !== undefined) {
    if (typeof body.status !== 'string' || !COMMENT_STATUSES.includes(body.status as CommentStatus)) {
      throw new ApiError('bad-request', 'The status is "open", "sent" or "resolved".');
    }
    patch.status = body.status as CommentStatus;
    fields += 1;
  }
  if (fields === 0) throw new ApiError('bad-request', 'Say what to change: "body" and/or "status".');
  return patch;
};

const validateMarkSent = (body: unknown): MarkSentBody => {
  if (!isBodyRecord(body)) throw new ApiError('bad-request', 'The mark-sent request must be a JSON object.');
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > COMMENTS_MAX) {
    throw new ApiError('bad-request', 'List the comment ids to mark as sent (at least one).');
  }
  for (const id of body.ids) {
    if (typeof id !== 'string' || !COMMENT_ID_PATTERN.test(id)) throw new ApiError('bad-request', 'That is not a comment id.');
  }
  const { version } = body;
  if (version !== null && (!Number.isInteger(version) || (version as number) < 1)) {
    throw new ApiError('bad-request', 'The version is a version number or null.');
  }
  // Safe: every id and the version were type-checked just above.
  return { ids: [...new Set(body.ids as string[])], version: version as number | null };
};

/**
 * Registers:
 * - 'POST /designs/:slug/comments'
 * - 'PATCH /designs/:slug/comments/:id'
 * - 'DELETE /designs/:slug/comments/:id'
 * - 'POST /designs/:slug/comments/mark-sent'
 * Comments are service-owned (§6.3): the store writes state.json first, then the mirror.
 */
export function registerCommentsRoutes(router: Router, ctx: ServiceContext): void {
  router.on('POST /designs/:slug/comments', async ({ params, body }): Promise<CommentResponse> => ({
    comment: await ctx.store.addComment(params.slug, validateCreate(body)),
  }));

  router.on('PATCH /designs/:slug/comments/:id', async ({ params, body }): Promise<CommentResponse> => {
    if (!COMMENT_ID_PATTERN.test(params.id)) throw new ApiError('bad-request', 'That is not a comment id.');
    return { comment: await ctx.store.updateComment(params.slug, params.id, validatePatch(body)) };
  });

  router.on('DELETE /designs/:slug/comments/:id', async ({ params }): Promise<OkResponse> => {
    if (!COMMENT_ID_PATTERN.test(params.id)) throw new ApiError('bad-request', 'That is not a comment id.');
    await ctx.store.deleteComment(params.slug, params.id);
    return { ok: true };
  });

  router.on('POST /designs/:slug/comments/mark-sent', async ({ params, body }): Promise<MarkSentResponse> => {
    const validated = validateMarkSent(body);
    return { comments: await ctx.store.markSent(params.slug, validated.ids, validated.version) };
  });
}
