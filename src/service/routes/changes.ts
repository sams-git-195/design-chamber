// WP1 — GET /changes (docs/SPEC.md §7, §9.4): the long-poll the guests' change loops live on.
// `wait` is capped at CHANGES_WAIT_MAX_MS (15 s) so the answer always beats the host's 20 s
// serviceRequest timeout (F8). An aborted request (caller went away) resolves the wait early
// through the router's AbortSignal; the answer is then dropped by http.ts.

import type { ChangesResponse } from '../../shared/api.ts';
import { CHANGES_WAIT_MAX_MS } from '../../shared/limits.ts';
import type { ServiceContext } from '../context.ts';
import { ApiError, type Router } from '../http.ts';

const parseCount = (raw: string | null, fallback: number, label: string, max?: number): number => {
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new ApiError('bad-request', `The ${label} must be a whole number.`);
  return max === undefined ? value : Math.min(value, max);
};

/**
 * Registers:
 * - 'GET /changes'
 * The first call (`since=0&epoch=`) answers `reset:true` (WP0 deviation 6): the hub's epoch
 * never matches the empty string.
 */
export function registerChangesRoutes(router: Router, ctx: ServiceContext): void {
  router.on('GET /changes', ({ query, signal }): Promise<ChangesResponse> => {
    const since = parseCount(query.get('since'), 0, 'since cursor');
    const wait = parseCount(query.get('wait'), 0, 'wait time', CHANGES_WAIT_MAX_MS);
    const epoch = query.get('epoch') ?? '';
    return ctx.hub.waitFor(since, epoch, wait, signal);
  });
}
