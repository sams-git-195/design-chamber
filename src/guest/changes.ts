// The change feed (docs/SPEC.md §4.8, §8.2): one long-poll loop per frame on `GET /changes`
// (wait 15 s, under the host's 20 s timeout), backoff 1 → 10 s on errors, paused while the
// frame is hidden, stopped on dispose. Listeners get each non-empty batch; `reset: true`
// means "refetch everything" (service restarted, or we fell out of its 500-event ring).

import type { ChangeEvent } from '../shared/types.ts';
import { CHANGES_BACKOFF_MAX_MS, CHANGES_BACKOFF_MIN_MS, CHANGES_WAIT_MAX_MS } from '../shared/limits.ts';
import { toServiceError, type ServiceClient, type ServiceError } from './service-client.ts';

export type ChangeBatch = { reset: boolean; events: ChangeEvent[]; epoch: string; seq: number };

export type FeedStatus = { state: 'connecting' | 'live' | 'retrying' | 'paused' | 'stopped'; error: ServiceError | null; retryInMs: number | null };

/** Page visibility, injectable for tests. Defaults to `document.hidden` + `visibilitychange`. */
export type VisibilitySource = { hidden(): boolean; onChange(listener: () => void): () => void };

export type ChangeFeedOptions = {
  waitMs?: number;
  /** Test seam for backoff waits. */
  sleep?: (ms: number) => Promise<void>;
  visibility?: VisibilitySource | null;
};

export type ChangeFeed = {
  start(): void;
  stop(): void;
  subscribe(listener: (batch: ChangeBatch) => void): () => void;
  onStatus(listener: (status: FeedStatus) => void): () => void;
  status(): FeedStatus;
};

const documentVisibility = (): VisibilitySource | null => {
  if (typeof document === 'undefined') return null;
  return {
    hidden: () => document.hidden,
    onChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const nextBackoff = (current: number): number => Math.min(CHANGES_BACKOFF_MAX_MS, Math.max(CHANGES_BACKOFF_MIN_MS, current * 2));

export const createChangeFeed = (client: ServiceClient, options: ChangeFeedOptions = {}): ChangeFeed => {
  const wait = Math.min(options.waitMs ?? CHANGES_WAIT_MAX_MS, CHANGES_WAIT_MAX_MS);
  const sleep = options.sleep ?? defaultSleep;
  const visibility = options.visibility === undefined ? documentVisibility() : options.visibility;
  const listeners = new Set<(batch: ChangeBatch) => void>();
  const statusListeners = new Set<(status: FeedStatus) => void>();

  let since = 0;
  let epoch = '';
  /** Bumped on every start/stop so an old loop notices it is no longer the current one. */
  let generation = 0;
  let running = false;
  let status: FeedStatus = { state: 'stopped', error: null, retryInMs: null };
  let wakeVisible: (() => void) | null = null;
  let unwatchVisibility: (() => void) | null = null;

  const setStatus = (next: FeedStatus): void => {
    status = next;
    for (const listener of [...statusListeners]) listener(next);
  };

  const whenVisible = (): Promise<void> =>
    new Promise((resolve) => {
      if (!visibility || !visibility.hidden()) return resolve();
      wakeVisible = resolve;
    });

  const loop = async (mine: number): Promise<void> => {
    let backoff = CHANGES_BACKOFF_MIN_MS;
    while (running && mine === generation) {
      if (visibility?.hidden()) {
        setStatus({ state: 'paused', error: null, retryInMs: null });
        await whenVisible();
        continue;
      }
      try {
        const answer = await client.call('GET /changes', { query: { since: String(since), epoch, wait: String(wait) } });
        if (!running || mine !== generation) return;
        backoff = CHANGES_BACKOFF_MIN_MS;
        if (status.state !== 'live') setStatus({ state: 'live', error: null, retryInMs: null });
        const batch: ChangeBatch = { reset: answer.reset, events: answer.events, epoch: answer.epoch, seq: answer.seq };
        since = answer.seq;
        epoch = answer.epoch;
        if (batch.reset || batch.events.length > 0) for (const listener of [...listeners]) listener(batch);
      } catch (error) {
        if (!running || mine !== generation) return;
        setStatus({ state: 'retrying', error: toServiceError(error), retryInMs: backoff });
        await sleep(backoff);
        backoff = nextBackoff(backoff);
      }
    }
  };

  return {
    start: () => {
      if (running) return;
      running = true;
      generation += 1;
      setStatus({ state: 'connecting', error: null, retryInMs: null });
      unwatchVisibility =
        visibility?.onChange(() => {
          if (!visibility.hidden() && wakeVisible) {
            const wake = wakeVisible;
            wakeVisible = null;
            wake();
          }
        }) ?? null;
      void loop(generation);
    },
    stop: () => {
      if (!running) return;
      running = false;
      generation += 1;
      unwatchVisibility?.();
      unwatchVisibility = null;
      const wake = wakeVisible;
      wakeVisible = null;
      wake?.();
      setStatus({ state: 'stopped', error: null, retryInMs: null });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStatus: (listener) => {
      statusListeners.add(listener);
      return () => statusListeners.delete(listener);
    },
    status: () => status,
  };
};
