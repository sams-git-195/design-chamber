// The change hub (docs/SPEC.md §9.4): an in-memory ring of the last `CHANGES_RING_SIZE`
// events with a monotonic `seq` and a per-process `epoch`. Guests long-poll it through
// GET /changes; in-process listeners (design.json merge, and WP2's render cache, thumbnails
// and versions) subscribe directly.
//
// Reset semantics (§7): a client whose `epoch` differs (service restarted) or whose `since`
// fell out of the ring answers `reset: true` and must refetch everything. The first call
// (`since=0&epoch=`) always resets (SPEC §14, WP0 deviation 6).

import { CHANGES_RING_SIZE, CHANGES_WAIT_MAX_MS } from '../shared/limits.ts';
import type { ChangesResponse } from '../shared/api.ts';
import type { ChangeEvent, ChangeKind } from '../shared/types.ts';
import type { ChangeHub } from './context.ts';

export type ChangeHubOptions = {
  /** Ring capacity; default `CHANGES_RING_SIZE` (500). */
  ringSize?: number;
};

export const createChangeHub = (epoch: string, options: ChangeHubOptions = {}): ChangeHub => {
  const ringSize = options.ringSize ?? CHANGES_RING_SIZE;
  const ring: ChangeEvent[] = [];
  const listeners = new Set<(event: ChangeEvent) => void>();
  let seq = 0;

  const answer = (since: number, clientEpoch: string): ChangesResponse => {
    if (clientEpoch !== epoch) return { epoch, seq, reset: true, events: [] };
    const oldest = ring[0];
    // With events in the ring, `since` must be at least the oldest retained seq - 1;
    // an empty ring can only answer for a client that has seen everything (since >= seq).
    const canServe = oldest === undefined ? since >= seq : since >= oldest.seq - 1;
    if (!canServe) return { epoch, seq, reset: true, events: [] };
    return { epoch, seq, reset: false, events: ring.filter((event) => event.seq > since) };
  };

  return {
    epoch,
    seq: () => seq,
    emit(input: { slug: string | null; kind: ChangeKind; files?: string[] }): ChangeEvent {
      seq += 1;
      const event: ChangeEvent = { seq, slug: input.slug, kind: input.kind, ...(input.files ? { files: input.files } : {}) };
      ring.push(event);
      if (ring.length > ringSize) ring.splice(0, ring.length - ringSize);
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    waitFor(since: number, clientEpoch: string, waitMs: number, signal?: AbortSignal): Promise<ChangesResponse> {
      const ms = Math.min(Math.max(Number.isFinite(waitMs) ? waitMs : 0, 0), CHANGES_WAIT_MAX_MS);
      const first = answer(since, clientEpoch);
      if (first.reset || first.events.length > 0 || ms === 0 || signal?.aborted) return Promise.resolve(first);
      return new Promise((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          listeners.delete(onEvent);
          signal?.removeEventListener('abort', finish);
          resolve(answer(since, clientEpoch));
        };
        const onEvent = (): void => finish();
        listeners.add(onEvent);
        const timer = setTimeout(finish, ms);
        // A hanging long-poll must never keep the process alive on shutdown.
        timer.unref?.();
        signal?.addEventListener('abort', finish, { once: true });
      });
    },
    subscribe(listener: (event: ChangeEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
