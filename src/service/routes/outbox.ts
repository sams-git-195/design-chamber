// WP1 — GET /outbox, PUT /outbox, DELETE /outbox (docs/SPEC.md §7, §10.4): the one-slot
// hand-off that lets the page deliver "send comments" to a session the rail must open first
// (openSession closes the page, F12). DELETE takes the slot exactly once.

import type { OutboxResponse, PutOutboxBody } from '../../shared/api.ts';
import { COMMENT_ID_PATTERN, COMMENTS_MAX, HOST_TEXT_MAX, SESSION_ID_MAX } from '../../shared/limits.ts';
import type { ServiceContext } from '../context.ts';
import { ApiError, type Router } from '../http.ts';
import { isSlug } from '../paths.ts';

const isBodyRecord = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body);

const validatePut = (body: unknown): PutOutboxBody => {
  if (!isBodyRecord(body)) throw new ApiError('bad-request', 'The outbox entry must be a JSON object.');
  const { sessionId, slug, text, commentIds, version } = body;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0 || sessionId.length > SESSION_ID_MAX) {
    throw new ApiError('bad-request', 'The outbox entry needs the chat session id it is for.');
  }
  if (!isSlug(slug)) throw new ApiError('bad-slug', 'That is not a design name.');
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > HOST_TEXT_MAX) {
    throw new ApiError('bad-request', `The revision message must be 1–${HOST_TEXT_MAX} characters.`);
  }
  if (!Array.isArray(commentIds) || commentIds.length > COMMENTS_MAX || commentIds.some((id) => typeof id !== 'string' || !COMMENT_ID_PATTERN.test(id))) {
    throw new ApiError('bad-request', 'List the comment ids this message carries.');
  }
  if (version !== null && (!Number.isInteger(version) || (version as number) < 1)) {
    throw new ApiError('bad-request', 'The version is a version number or null.');
  }
  // Safe: every field was type-checked just above.
  return { sessionId, slug, text, commentIds: commentIds as string[], version: version as number | null };
};

/**
 * Registers:
 * - 'GET /outbox'
 * - 'PUT /outbox'
 * - 'DELETE /outbox'
 */
export function registerOutboxRoutes(router: Router, ctx: ServiceContext): void {
  router.on('GET /outbox', (): OutboxResponse => ({ outbox: ctx.outbox.get() }));
  router.on('PUT /outbox', ({ body }): OutboxResponse => ({ outbox: ctx.outbox.put(validatePut(body)) }));
  router.on('DELETE /outbox', (): OutboxResponse => ({ outbox: ctx.outbox.take() }));
}
