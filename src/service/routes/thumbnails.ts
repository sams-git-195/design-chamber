// WP2 — GET /designs/:slug/thumbnail, POST /designs/:slug/thumbnail/refresh (docs/SPEC.md §7, §4.4, §9.5).

import type { ThumbnailRefreshResponse, ThumbnailResponse } from '../../shared/api.ts';
import type { Router } from '../http.ts';
import type { ServiceContext } from '../context.ts';
import { ensureThumbnailService } from '../thumbnails.ts';

/**
 * Registers:
 * - 'GET /designs/:slug/thumbnail'
 * - 'POST /designs/:slug/thumbnail/refresh'
 * The slug is validated by the store; the PNG is answered as base64 inside JSON (F2 allows
 * `img-src data:`), never as a binary body (F8: the host reads answers as UTF-8 text).
 */
export function registerThumbnailsRoutes(router: Router, ctx: ServiceContext): void {
  // The service is created lazily (first request): until integration, main.ts passes
  // placeholder modules whose hub methods throw — registration itself must not.

  router.on('GET /designs/:slug/thumbnail', async ({ params }): Promise<ThumbnailResponse> => ensureThumbnailService(ctx).get(params.slug));

  router.on('POST /designs/:slug/thumbnail/refresh', async ({ params }): Promise<ThumbnailRefreshResponse> => ensureThumbnailService(ctx).refresh(params.slug));
}
