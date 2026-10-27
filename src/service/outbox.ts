// The outbox slot (docs/SPEC.md §7, §10.4): one pending "send comments" delivery for a
// session that is not currently selected. The page PUTs the revision text, opens the rail
// panel and calls `openSession` (which closes the page, F12); the rail — mounted afterwards —
// GET/DELETEs the slot and delivers it to the host. DELETE takes the slot exactly once.
// In memory, TTL 10 min, single slot: a newer PUT replaces an older undelivered message.

import { ApiError } from './http.ts';
import { HOST_TEXT_MAX, OUTBOX_TTL_MS } from '../shared/limits.ts';
import type { PutOutboxBody } from '../shared/api.ts';
import type { Outbox } from '../shared/types.ts';
import type { OutboxStore } from './context.ts';

export type OutboxStoreOptions = {
  /** Test seam for the TTL; defaults to `Date.now`. */
  now?: () => number;
};

export const createOutboxStore = (options: OutboxStoreOptions = {}): OutboxStore => {
  const now = options.now ?? Date.now;
  let slot: { outbox: Outbox; created: number } | null = null;

  const fresh = (): Outbox | null => {
    if (slot !== null && now() - slot.created > OUTBOX_TTL_MS) slot = null;
    return slot?.outbox ?? null;
  };

  return {
    get: () => fresh(),
    put(input: PutOutboxBody): Outbox {
      if (input.text.length > HOST_TEXT_MAX) {
        throw new ApiError('too-large', 'That revision message is longer than the chat accepts.');
      }
      const outbox: Outbox = { ...input, created: new Date(now()).toISOString() };
      slot = { outbox, created: now() };
      return outbox;
    },
    take: () => {
      const taken = fresh();
      slot = null;
      return taken;
    },
  };
};
