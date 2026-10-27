// Chunked text uploads, guest → service (docs/SPEC.md §7, §8.2). The host caps one
// `serviceRequest` body at 64 000 chars (F7), so larger texts (a big artifact HTML, an
// assistant message for "Open as artifact") arrive as ordered chunks of one upload:
// POST /uploads mints an id, PUT /uploads/:id/:index stores chunks strictly in order,
// and the consumer `take`s the joined text exactly once. TTL 10 min, ≤ 8 open uploads.
// Purely in-memory: an upload never touches disk, and a service restart drops it
// (the guest chunker retries from scratch).

import { randomBytes } from 'node:crypto';

import { ApiError } from './http.ts';
import { UPLOAD_TTL_MS, UPLOADS_OPEN_MAX, UPLOAD_TOTAL_MAX } from '../shared/limits.ts';
import type { PutUploadChunkResponse } from '../shared/api.ts';
import type { UploadStore } from './context.ts';

export type UploadStoreOptions = {
  /** Test seam for the TTL; defaults to `Date.now`. */
  now?: () => number;
  /** Test seam for id minting. */
  randomId?: () => string;
};

type Entry = {
  id: string;
  total: number;
  chunks: string[];
  received: number;
  created: number;
};

const mintId = (): string => `u_${randomBytes(16).toString('base64url')}`;

export const createUploadStore = (options: UploadStoreOptions = {}): UploadStore => {
  const now = options.now ?? Date.now;
  const newId = options.randomId ?? mintId;
  const open = new Map<string, Entry>();

  /** Drop expired uploads (lazy sweep on every operation — no timers to leak). */
  const sweep = (): void => {
    const cutoff = now() - UPLOAD_TTL_MS;
    for (const [id, entry] of open) if (entry.created < cutoff) open.delete(id);
  };

  const need = (id: string): Entry => {
    sweep();
    const entry = open.get(id);
    if (entry === undefined) throw new ApiError('not-found', 'That upload does not exist or has expired — send the text again.');
    return entry;
  };

  return {
    create(total: number): string {
      sweep();
      if (!Number.isInteger(total) || total < 0) throw new ApiError('bad-request', 'The upload size must be a whole number of characters.');
      if (total > UPLOAD_TOTAL_MAX) {
        throw new ApiError('too-large', `That text is larger than the ${UPLOAD_TOTAL_MAX.toLocaleString('en-US')} characters Design Chamber accepts.`);
      }
      if (open.size >= UPLOADS_OPEN_MAX) {
        throw new ApiError('conflict', 'Too many uploads are open right now — finish or wait a few minutes for the old ones to expire.');
      }
      const id = newId();
      open.set(id, { id, total, chunks: [], received: 0, created: now() });
      return id;
    },
    put(id: string, index: number, data: string): PutUploadChunkResponse {
      const entry = need(id);
      if (!Number.isInteger(index) || index < 0) throw new ApiError('bad-request', 'The chunk number must be a whole number starting at 0.');
      if (typeof data !== 'string') throw new ApiError('bad-request', 'An upload chunk must be text.');
      if (index !== entry.chunks.length) {
        throw new ApiError('conflict', `Chunks must arrive in order: this upload waits for chunk ${entry.chunks.length}, not ${index}.`);
      }
      if (entry.received + data.length > entry.total) {
        throw new ApiError('too-large', 'This upload has received more text than it announced.');
      }
      entry.chunks.push(data);
      entry.received += data.length;
      return { received: entry.received, complete: entry.received === entry.total };
    },
    take(id: string): string {
      const entry = need(id);
      if (entry.received !== entry.total) {
        throw new ApiError('conflict', `The upload is not complete yet (${entry.received} of ${entry.total} characters).`);
      }
      open.delete(id);
      return entry.chunks.join('');
    },
  };
};
