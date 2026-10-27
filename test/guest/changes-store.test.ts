import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GuestRequest, GuestRequestResult } from '@openchamber/sdk';

import { createChangeFeed, nextBackoff, type ChangeBatch, type VisibilitySource } from '../../src/guest/changes.ts';
import { createFakeService } from '../../src/guest/fake-services.ts';
import { createServiceClient } from '../../src/guest/service-client.ts';
import { affectedSources, createStore, renderSourceKey } from '../../src/guest/store.ts';
import type { ChangesResponse } from '../../src/shared/api.ts';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const until = async (check: () => boolean, label: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if (check()) return;
    await tick();
  }
  assert.fail(`timed out waiting for ${label}`);
};

const scripted = (answers: (GuestRequestResult | Error)[]) => {
  const requests: GuestRequest[] = [];
  let release: (() => void) | null = null;
  const client = createServiceClient({
    serviceRequest: async (request) => {
      requests.push(request);
      const next = answers.shift();
      if (next === undefined) {
        // Park like a long-poll until the test stops the feed.
        await new Promise<void>((resolve) => (release = resolve));
        return { status: 200, body: JSON.stringify({ epoch: 'e', seq: 0, reset: false, events: [] }) };
      }
      if (next instanceof Error) throw next;
      return next;
    },
  });
  return { requests, client, release: () => release?.() };
};

const changes = (body: ChangesResponse): GuestRequestResult => ({ status: 200, body: JSON.stringify(body) });

test('change feed: first call since=0 epoch="" wait=15000, then follows seq/epoch; empty batches are not emitted', async () => {
  const { requests, client, release } = scripted([
    changes({ epoch: 'e1', seq: 4, reset: true, events: [] }),
    changes({ epoch: 'e1', seq: 4, reset: false, events: [] }),
    changes({ epoch: 'e1', seq: 6, reset: false, events: [{ seq: 5, slug: 'a', kind: 'files', files: ['screens/home.html'] }, { seq: 6, slug: 'a', kind: 'thumb' }] }),
  ]);
  const feed = createChangeFeed(client, { visibility: null });
  const batches: ChangeBatch[] = [];
  feed.subscribe((batch) => batches.push(batch));
  feed.start();
  await until(() => requests.length === 4, '4 requests');
  assert.deepEqual(
    requests.map((request) => request.query),
    [
      { since: '0', epoch: '', wait: '15000' },
      { since: '4', epoch: 'e1', wait: '15000' },
      { since: '4', epoch: 'e1', wait: '15000' },
      { since: '6', epoch: 'e1', wait: '15000' },
    ],
  );
  assert.deepEqual(batches.map((batch) => [batch.reset, batch.events.length]), [[true, 0], [false, 2]]);
  assert.equal(feed.status().state, 'live');
  feed.stop();
  release();
  await tick();
  assert.equal(requests.length, 4, 'no request after stop');
  assert.equal(feed.status().state, 'stopped');
});

test('change feed: backoff 1 → 2 → 4 → 8 → 10 s on errors, reset after a success', async () => {
  const failure = { status: 500, body: JSON.stringify({ error: 'internal', message: 'Down.' }) };
  const { client, release } = scripted([failure, failure, failure, failure, failure, failure, changes({ epoch: 'e', seq: 1, reset: true, events: [] }), failure]);
  const sleeps: number[] = [];
  const feed = createChangeFeed(client, { visibility: null, sleep: async (ms) => void sleeps.push(ms) });
  const statuses: string[] = [];
  feed.onStatus((status) => statuses.push(`${status.state}${status.retryInMs ?? ''}`));
  feed.start();
  await until(() => sleeps.length === 7, '7 sleeps');
  assert.deepEqual(sleeps, [1000, 2000, 4000, 8000, 10000, 10000, 1000]);
  assert.ok(statuses.includes('retrying1000') && statuses.includes('live'));
  assert.equal(nextBackoff(10_000), 10_000);
  feed.stop();
  release();
});

test('change feed: pauses while hidden and resumes when visible', async () => {
  let hidden = true;
  let notify: () => void = () => undefined;
  const visibility: VisibilitySource = { hidden: () => hidden, onChange: (listener) => ((notify = listener), () => undefined) };
  const { requests, client, release } = scripted([]);
  const feed = createChangeFeed(client, { visibility });
  feed.start();
  await tick();
  assert.equal(requests.length, 0);
  assert.equal(feed.status().state, 'paused');
  hidden = false;
  notify();
  await until(() => requests.length === 1, 'request after visible');
  feed.stop();
  release();
});

test('affectedSources: screen file → its screen, design.json → none, shared files → all', () => {
  const canvas = { kind: 'canvas' as const, screens: [{ id: 'home', title: 'Home', file: 'screens/home.html' }, { id: 'pricing', title: 'Pricing', file: 'screens/pricing.html' }] };
  assert.deepEqual(affectedSources(canvas, ['screens/home.html']), ['home']);
  assert.deepEqual(affectedSources(canvas, ['screens/home.html', 'screens/pricing.html', 'design.json']), ['home', 'pricing']);
  assert.deepEqual(affectedSources(canvas, ['design.json']), []);
  for (const shared of ['tokens.css', 'assets/logo.svg', 'DESIGN.md', 'screens/unknown.html']) assert.equal(affectedSources(canvas, [shared]), 'all', shared);
  assert.equal(affectedSources({ kind: 'artifact', screens: [] }, ['index.html']), 'all');
});

test('store: list, open, live refresh of only the affected artboards, comments and versions', async () => {
  const service = createFakeService();
  const client = createServiceClient({ serviceRequest: (request) => service.handle(request) });
  const store = createStore({ client });
  const statuses: string[] = [];
  store.subscribe((state, previous) => {
    if (state.designs.status !== previous.designs.status) statuses.push(state.designs.status);
  });

  await store.refreshDesigns();
  assert.deepEqual(statuses, ['loading', 'ready']);
  assert.deepEqual(store.getState().designs.data?.designs.map((d) => [d.slug, d.pending]).sort(), [
    ['coffee-subscription', false],
    ['launch-announcement', false],
    ['onboarding-flow', true],
  ]);

  await store.openDesign('coffee-subscription');
  assert.equal(store.getState().open?.status, 'ready');
  assert.equal(store.getState().open?.data?.design.screens.length, 2);

  // The agent edits one screen: only that row's artboards reload.
  await store.applyChanges({ reset: false, epoch: 'e', seq: 1, events: [{ seq: 1, slug: 'coffee-subscription', kind: 'files', files: ['screens/pricing.html'] }] });
  assert.deepEqual(store.getState().renderRevs, { [renderSourceKey('coffee-subscription', 'pricing')]: 1 });
  // tokens.css → every screen.
  await store.applyChanges({ reset: false, epoch: 'e', seq: 2, events: [{ seq: 2, slug: 'coffee-subscription', kind: 'files', files: ['tokens.css'] }] });
  assert.deepEqual(store.getState().renderRevs, { 'coffee-subscription|pricing': 2, 'coffee-subscription|home': 1 });

  const comment = await store.addComment('coffee-subscription', {
    screen: 'home',
    viewport: 'laptop',
    anchor: { selector: 'h1', text: 'x', html: '<h1>', rect: { x: 0, y: 0, w: 1, h: 1 }, point: { x: 0.5, y: 0.5 } },
    body: 'Bigger',
  });
  assert.ok(store.getState().open?.data?.design.comments.some((c) => c.id === comment.id));
  await store.updateComment('coffee-subscription', comment.id, { status: 'resolved' });
  assert.equal(store.getState().open?.data?.design.comments.find((c) => c.id === comment.id)?.status, 'resolved');
  await store.deleteComment('coffee-subscription', comment.id);
  assert.ok(!store.getState().open?.data?.design.comments.some((c) => c.id === comment.id));

  await store.loadVersions('coffee-subscription');
  const count = store.getState().versions?.data?.versions.length ?? 0;
  await store.snapshotVersion('coffee-subscription', 'Before pricing rework');
  await until(() => (store.getState().versions?.data?.versions.length ?? 0) === count + 1, 'versions reload');

  await store.renameDesign('coffee-subscription', 'Coffee club');
  assert.equal(store.getState().open?.data?.design.title, 'Coffee club');
  assert.equal(store.getState().designs.data?.designs.find((d) => d.slug === 'coffee-subscription')?.title, 'Coffee club');
});

test('store: an `added` event for the open design reloads every artboard of its fresh detail', async () => {
  const service = createFakeService();
  const client = createServiceClient({ serviceRequest: (request) => service.handle(request) });
  const store = createStore({ client });
  await store.openDesign('coffee-subscription');
  const screens = store.getState().open?.data?.design.screens.map((screen) => screen.id) ?? [];
  assert.ok(screens.length > 0);
  // The agent wrote the files within the service's coalescing window: only `added` arrives.
  await store.applyChanges({ reset: false, epoch: 'e', seq: 1, events: [{ seq: 1, slug: 'coffee-subscription', kind: 'added' }] });
  assert.deepEqual(store.getState().renderRevs, Object.fromEntries(screens.map((id) => [renderSourceKey('coffee-subscription', id), 1])));
  // `added` for another design only refreshes the list.
  await store.applyChanges({ reset: false, epoch: 'e', seq: 2, events: [{ seq: 2, slug: 'launch-announcement', kind: 'added' }] });
  assert.equal(Object.keys(store.getState().renderRevs).length, screens.length);
});

test('store: errors land in state with the service sentence; mutations reject with it; reset refetches', async () => {
  const service = createFakeService();
  const client = createServiceClient({ serviceRequest: (request) => service.handle(request) });
  const store = createStore({ client });
  await store.openDesign('does-not-exist');
  const open = store.getState().open;
  assert.equal(open?.status, 'error');
  assert.equal(open?.error?.code, 'not-found');
  assert.match(open?.error?.message ?? '', /no longer exists/);
  await assert.rejects(store.renameDesign('does-not-exist', 'x'), /no longer exists/);

  await store.checkHealth();
  assert.equal(store.getState().service.state, 'ready');

  await store.openDesign('launch-announcement');
  const before = service.requests.length;
  await store.applyChanges({ reset: true, epoch: 'e2', seq: 0, events: [] });
  const paths = service.requests.slice(before).map((request) => `${request.method} ${request.path}`).sort();
  assert.deepEqual(paths, ['GET /designs', 'GET /designs/launch-announcement', 'GET /settings']);
  assert.equal(store.getState().renderRevs['launch-announcement|'], 1);

  await store.deleteDesign('launch-announcement');
  assert.equal(store.getState().open, null);
  assert.ok(!store.getState().designs.data?.designs.some((d) => d.slug === 'launch-announcement'));
});
