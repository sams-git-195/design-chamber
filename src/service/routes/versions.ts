// WP2 — GET /designs/:slug/versions, POST /designs/:slug/versions, POST /versions/turn, GET /designs/:slug/versions/:vid/diff, POST /designs/:slug/versions/:vid/restore (docs/SPEC.md §7, §6.4, §9.5).

import { SESSION_ID_MAX, VERSION_ID_PATTERN, VERSION_LABEL_MAX } from '../../shared/limits.ts';
import type {
  CreateVersionBody,
  CreateVersionResponse,
  RestoreVersionResponse,
  TurnSnapshotBody,
  TurnSnapshotResponse,
  VersionDiffResponse,
  VersionListResponse,
} from '../../shared/api.ts';
import { ApiError, type Router } from '../http.ts';
import type { ServiceContext } from '../context.ts';
import { ensureVersionsService } from '../versions.ts';

const parseVid = (vid: string): string => {
  if (!VERSION_ID_PATTERN.test(vid)) throw new ApiError('bad-request', 'That is not a version id.');
  return vid;
};

const parseSessionId = (value: unknown): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string' && value.length >= 1 && value.length <= SESSION_ID_MAX) return value;
  throw new ApiError('bad-request', 'That is not a chat session id.');
};

/**
 * Registers:
 * - 'GET /designs/:slug/versions'
 * - 'POST /designs/:slug/versions'
 * - 'POST /versions/turn'
 * - 'GET /designs/:slug/versions/:vid/diff'
 * - 'POST /designs/:slug/versions/:vid/restore'
 * Bodies are validated at the boundary; every path is resolved by the store or inside the
 * design folder's `.versions/` (content-addressed object names are sha256-checked).
 */
export function registerVersionsRoutes(router: Router, ctx: ServiceContext): void {
  // The service is created lazily (first request): until integration, main.ts passes
  // placeholder modules whose hub methods throw — registration itself must not.

  router.on('GET /designs/:slug/versions', async ({ params }): Promise<VersionListResponse> => ensureVersionsService(ctx).list(params.slug));

  router.on('POST /designs/:slug/versions', async ({ params, body }): Promise<CreateVersionResponse> => {
    const input = (body ?? {}) as Partial<CreateVersionBody>;
    if (input.reason !== 'turn' && input.reason !== 'manual') throw new ApiError('bad-request', 'A version is saved for an agent turn or manually.');
    const sessionId = parseSessionId(input.sessionId);
    if (input.label !== undefined && (typeof input.label !== 'string' || input.label.length > VERSION_LABEL_MAX)) {
      throw new ApiError('bad-request', 'That version label is too long.');
    }
    const created = await ensureVersionsService(ctx).create(params.slug, input.reason, {
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(typeof input.label === 'string' ? { label: input.label } : {}),
    });
    return { created };
  });

  router.on('POST /versions/turn', async ({ body }): Promise<TurnSnapshotResponse> => {
    const input = (body ?? {}) as Partial<TurnSnapshotBody>;
    if (typeof input.sessionId !== 'string' || input.sessionId.length < 1 || input.sessionId.length > SESSION_ID_MAX) {
      throw new ApiError('bad-request', 'That is not a chat session id.');
    }
    const created = await ensureVersionsService(ctx).turn(input.sessionId);
    return { created };
  });

  router.on('GET /designs/:slug/versions/:vid/diff', async ({ params, query }): Promise<VersionDiffResponse> => {
    const against = query.get('against') ?? 'current';
    if (against !== 'current') parseVid(against);
    return ensureVersionsService(ctx).diff(params.slug, parseVid(params.vid), against);
  });

  router.on('POST /designs/:slug/versions/:vid/restore', async ({ params }): Promise<RestoreVersionResponse> =>
    ensureVersionsService(ctx).restore(params.slug, parseVid(params.vid)),
  );
}
