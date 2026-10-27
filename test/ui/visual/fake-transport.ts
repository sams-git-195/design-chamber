// Visual harness only: the fake backend behind the host's `serviceRequest`, so the real service
// client, store, change feed and flows run unchanged. Adds the long-poll `GET /changes` from
// the backend's change events, and answers the chat routes the flows touch on mount.

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';

import { API_ERROR_STATUS, RAW_TEXT_ROUTES, ROUTE_KEYS, isApiErrorCode, splitRouteKey, type RouteKey } from '../../../src/shared/api.ts';
import { CHANGES_RING_SIZE, CHANGES_WAIT_MAX_MS } from '../../../src/shared/limits.ts';
import type { ChangeEvent } from '../../../src/shared/types.ts';
import { createFakeBackend, type FakeBackend } from './fake-backend.ts';

type Matched = { key: RouteKey; params: Record<string, string> };

const matchRoute = (method: string, path: string): Matched | null => {
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  for (const key of ROUTE_KEYS) {
    const route = splitRouteKey(key);
    if (route.method !== method) continue;
    const pattern = route.pattern.split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((part, index) => {
      const value = segments[index] ?? '';
      if (part.startsWith(':')) params[part.slice(1)] = value;
      return part.startsWith(':') || part === value;
    });
    if (ok) return { key, params };
  }
  return null;
};

const json = (status: number, body: unknown): GuestRequestResult => ({ status, body: JSON.stringify(body) });

export type FakeTransport = { serviceRequest(request: GuestRequest): Promise<GuestRequestResult>; backend: FakeBackend };

export const createFakeTransport = (): FakeTransport => {
  const backend = createFakeBackend();
  const epoch = 'fake-epoch';
  const events: ChangeEvent[] = [];
  let seq = 0;
  const waiters = new Set<() => void>();
  backend.onChange((event) => {
    seq += 1;
    events.push({ ...event, seq });
    if (events.length > CHANGES_RING_SIZE) events.shift();
    for (const wake of [...waiters]) wake();
  });

  const changes = async (query: Record<string, string>): Promise<GuestRequestResult> => {
    const since = Number(query.since ?? '0');
    if (query.epoch !== epoch) return json(200, { epoch, seq, reset: true, events: [] });
    if (seq <= since) {
      const wait = Math.min(Number(query.wait ?? '0'), CHANGES_WAIT_MAX_MS);
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, wait);
        waiters.add(wake);
      });
    }
    return json(200, { epoch, seq, reset: false, events: events.filter((event) => event.seq > since) });
  };

  const serviceRequest = async (request: GuestRequest): Promise<GuestRequestResult> => {
    const matched = matchRoute(request.method, request.path);
    if (!matched) return json(404, { error: 'not-found', message: 'Unknown route.' });
    const query = request.query ?? {};
    switch (matched.key) {
      case 'GET /changes':
        return changes(query);
      case 'GET /outbox':
      case 'DELETE /outbox':
        return json(200, { outbox: null });
      case 'POST /versions/turn':
        return json(200, { created: null });
      default:
        break;
    }
    try {
      const body: unknown = request.body ? JSON.parse(request.body) : undefined;
      // Safe: the request was built by the typed service client for this route key.
      const answer: unknown = await backend.call(matched.key, { params: matched.params, query, body: body as never });
      return RAW_TEXT_ROUTES.has(matched.key) && typeof answer === 'string' ? { status: 200, body: answer } : json(200, answer);
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : 'internal';
      const message = error instanceof Error ? error.message : 'The fake service failed.';
      return isApiErrorCode(code) ? json(API_ERROR_STATUS[code], { error: code, message }) : json(500, { error: 'internal', message });
    }
  };

  return { serviceRequest, backend };
};
