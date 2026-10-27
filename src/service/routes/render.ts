// WP2 — GET /designs/:slug/render, GET /designs/:slug/render/chunk, GET /designs/:slug/source (docs/SPEC.md §7, §9.5).

import { readFile } from 'node:fs/promises';

import { SHA256_PATTERN, SCREEN_ID_PATTERN, SOURCE_TEXT_MAX } from '../../shared/limits.ts';
import type { RenderChunkResponse, SourceResponse } from '../../shared/api.ts';
import { ApiError, type Router } from '../http.ts';
import type { ServiceContext } from '../context.ts';
import { resolveInside } from '../paths.ts';
import { ensureRenderService } from '../render-cache.ts';
import { resolveEntryFile } from '../render-cache.ts';

/**
 * Registers:
 * - 'GET /designs/:slug/render'
 * - 'GET /designs/:slug/render/chunk'
 * - 'GET /designs/:slug/source'
 * Each handler validates its params and query at the boundary; every filesystem path comes
 * from the store (already contained) — the bundler contains each reference it resolves.
 */
export function registerRenderRoutes(router: Router, ctx: ServiceContext): void {
  // The service is created lazily (first request): until integration, main.ts passes
  // placeholder modules whose hub/store methods throw — registration itself must not.

  router.on('GET /designs/:slug/render', async ({ params, query }) => {
    const screen = query.get('screen') ?? undefined;
    const version = query.get('version') ?? undefined;
    if (screen !== undefined && !SCREEN_ID_PATTERN.test(screen)) throw new ApiError('bad-request', 'That is not a screen id.');
    return ensureRenderService(ctx).render(params.slug, { ...(screen !== undefined ? { screen } : {}), ...(version !== undefined ? { version } : {}) });
  });

  router.on('GET /designs/:slug/render/chunk', async ({ params, query }): Promise<RenderChunkResponse> => {
    // The slug is validated (existence + containment) even though the key addresses the cache:
    // a chunk of one design must not be readable through a fabricated slug's route.
    await ctx.store.dir(params.slug);
    const key = query.get('key') ?? '';
    if (!SHA256_PATTERN.test(key)) throw new ApiError('bad-request', 'That is not a render key.');
    const rawN = query.get('n') ?? '';
    if (!/^[0-9]{1,9}$/.test(rawN)) throw new ApiError('bad-request', 'That is not a chunk number.');
    return ensureRenderService(ctx).chunk(key, Number(rawN));
  });

  router.on('GET /designs/:slug/source', async ({ params, query }): Promise<SourceResponse> => {
    const screen = query.get('screen') ?? undefined;
    if (screen !== undefined && !SCREEN_ID_PATTERN.test(screen)) throw new ApiError('bad-request', 'That is not a screen id.');
    const record = await ctx.store.get(params.slug);
    const { entryRel } = resolveEntryFile(record.design, record.files, screen);
    // Contained like render (bundle.ts): a junction inside the design never leads out of it.
    const file = await resolveInside(record.path, entryRel.split('/')).catch(() => null);
    const bytes = file === null ? null : await readFile(file).catch(() => null);
    if (bytes === null) throw new ApiError('no-html', `The document for this view (${entryRel}) has not been written yet.`);
    const text = bytes.toString('utf8');
    if (text.length > SOURCE_TEXT_MAX) {
      throw new ApiError('too-large', 'This document is too large to copy out of Design Chamber.');
    }
    return { text, bytes: bytes.length };
  });
}
