// WP2 — POST /designs/:slug/export, POST /reveal (docs/SPEC.md §7, §4.3, §9.5).

import type { ExportBody, ExportResponse, OkResponse, RevealBody } from '../../shared/api.ts';
import { ApiError, type Router } from '../http.ts';
import type { ServiceContext } from '../context.ts';
import { createExportService, type ExportService } from '../export.ts';
import { createRevealRegistry, createRevealService, type RevealService } from '../reveal.ts';

type ExportLane = { exports: ExportService; reveal: RevealService };

// One registry per context: /reveal accepts exactly the paths THIS service's /export issued.
const lanes = new WeakMap<ServiceContext, ExportLane>();

const laneOf = (ctx: ServiceContext): ExportLane => {
  const existing = lanes.get(ctx);
  if (existing) return existing;
  const registry = createRevealRegistry();
  const lane: ExportLane = {
    exports: createExportService({ store: ctx.store, settings: ctx.settings, log: ctx.log, issue: registry.issue }),
    reveal: createRevealService({ store: ctx.store, log: ctx.log, registry }),
  };
  lanes.set(ctx, lane);
  return lane;
};

/**
 * Registers:
 * - 'POST /designs/:slug/export'
 * - 'POST /reveal'
 * The export body is validated at the boundary; reveal refuses every path the service did not
 * issue itself and that is not a design folder.
 */
export function registerExportRoutes(router: Router, ctx: ServiceContext): void {
  const lane = laneOf(ctx);

  router.on('POST /designs/:slug/export', async ({ params, body }): Promise<ExportResponse> => {
    const input = (body ?? {}) as Partial<ExportBody>;
    if (input.format !== 'zip' && input.format !== 'html') throw new ApiError('bad-request', 'The export format must be "zip" or "html".');
    if (input.screen !== undefined && typeof input.screen !== 'string') throw new ApiError('bad-request', 'That is not a screen id.');
    return lane.exports.export(params.slug, { format: input.format, ...(typeof input.screen === 'string' ? { screen: input.screen } : {}) });
  });

  router.on('POST /reveal', async ({ body }): Promise<OkResponse> => {
    const input = (body ?? {}) as Partial<RevealBody>;
    if (typeof input.path !== 'string') throw new ApiError('bad-path', 'That is not a path Design Chamber can open.');
    await lane.reveal.reveal(input.path);
    return { ok: true };
  });
}
