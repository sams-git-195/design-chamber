// The change hub (docs/SPEC.md §9.4) and the GET /changes long-poll semantics (§7):
// seq monotonic, 500-event ring, epoch reset, wake-on-event, timeout, abort.

import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';

import { createChangeHub } from '../../../src/service/changes.ts';
import { CHANGES_RING_SIZE } from '../../../src/shared/limits.ts';
import type { ChangeEvent } from '../../../src/shared/types.ts';

const EPOCH = 'epoch-a';

// The hub's wait timers are unref'd (a pending long-poll must never hold the service open; its
// HTTP server does). On Linux nothing else keeps this test process alive while a wait is
// pending, so node:test would cancel it — the file holds the event loop open itself.
const keepAlive = setInterval(() => undefined, 1000);
after(() => clearInterval(keepAlive));

describe('event ring and seq', () => {
  test('seq is monotonic and events carry their seq', () => {
    const hub = createChangeHub(EPOCH);
    assert.equal(hub.seq(), 0);
    const first = hub.emit({ slug: 'a', kind: 'design' });
    const second = hub.emit({ slug: 'b', kind: 'files', files: ['index.html'] });
    assert.equal(first.seq, 1);
    assert.equal(second.seq, 2);
    assert.equal(hub.seq(), 2);
    assert.equal(hub.epoch, EPOCH);
    assert.deepEqual(second.files, ['index.html']);
  });

  test('since filters; a client that has everything gets no events and no reset', async () => {
    const hub = createChangeHub(EPOCH);
    hub.emit({ slug: 'a', kind: 'design' });
    hub.emit({ slug: 'b', kind: 'design' });
    const answer = await hub.waitFor(1, EPOCH, 0);
    assert.equal(answer.reset, false);
    assert.deepEqual(answer.events.map((event) => event.seq), [2]);
    const none = await hub.waitFor(2, EPOCH, 0);
    assert.deepEqual(none.events, []);
    assert.equal(none.reset, false);
  });

  test('a differing epoch always resets with no events (WP0 deviation 6: the first call)', async () => {
    const hub = createChangeHub(EPOCH);
    hub.emit({ slug: 'a', kind: 'design' });
    for (const epoch of ['', 'other-epoch']) {
      const answer = await hub.waitFor(0, epoch, 0);
      assert.equal(answer.reset, true);
      assert.deepEqual(answer.events, []);
      assert.equal(answer.epoch, EPOCH);
    }
  });

  test('a since that fell out of the ring resets', async () => {
    const hub = createChangeHub(EPOCH, { ringSize: 5 });
    for (let index = 0; index < 7; index += 1) hub.emit({ slug: 'a', kind: 'files' });
    // Ring now holds seq 3..7; since=1 can no longer be served exactly.
    const lost = await hub.waitFor(1, EPOCH, 0);
    assert.equal(lost.reset, true);
    const servable = await hub.waitFor(2, EPOCH, 0);
    assert.equal(servable.reset, false);
    assert.deepEqual(servable.events.map((event) => event.seq), [3, 4, 5, 6, 7]);
  });

  test('the default ring holds CHANGES_RING_SIZE events', async () => {
    const hub = createChangeHub(EPOCH);
    for (let index = 0; index < CHANGES_RING_SIZE + 10; index += 1) hub.emit({ slug: 'a', kind: 'files' });
    const overflowed = await hub.waitFor(5, EPOCH, 0);
    assert.equal(overflowed.reset, true);
    const edge = await hub.waitFor(10, EPOCH, 0);
    assert.equal(edge.reset, false);
    assert.equal(edge.events.length, CHANGES_RING_SIZE);
  });
});

describe('waitFor long-poll', () => {
  test('resolves early when an event arrives', async () => {
    const hub = createChangeHub(EPOCH);
    const started = Date.now();
    const waiting = hub.waitFor(0, EPOCH, 10_000);
    setTimeout(() => hub.emit({ slug: 'a', kind: 'design' }), 40);
    const answer = await waiting;
    assert.ok(Date.now() - started < 5_000, `woke after ${Date.now() - started} ms`);
    assert.equal(answer.reset, false);
    assert.equal(answer.events.length, 1);
    assert.equal(answer.events[0]?.kind, 'design');
  });

  test('resolves with no events at the timeout', async () => {
    const hub = createChangeHub(EPOCH);
    const started = Date.now();
    const answer = await hub.waitFor(0, EPOCH, 120);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 100, `returned after only ${elapsed} ms`);
    assert.deepEqual(answer.events, []);
    assert.equal(answer.reset, false);
  });

  test('wait is clamped to CHANGES_WAIT_MAX_MS and 0 answers at once', async () => {
    const hub = createChangeHub(EPOCH);
    const started = Date.now();
    await hub.waitFor(0, EPOCH, 0);
    assert.ok(Date.now() - started < 500);
    // A huge wait does not hang forever without events — the clamp keeps it ≤ 15 s; we only
    // assert the call survives the absurd value (the route clamps too).
    const clamped = hub.waitFor(0, EPOCH, 999_999_999);
    setTimeout(() => hub.emit({ slug: 'a', kind: 'files' }), 20);
    assert.equal((await clamped).events.length, 1);
  });

  test('an aborted signal resolves the wait', async () => {
    const hub = createChangeHub(EPOCH);
    const controller = new AbortController();
    const waiting = hub.waitFor(0, EPOCH, 10_000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    const answer = await waiting;
    assert.deepEqual(answer.events, []);
    assert.equal(answer.epoch, EPOCH);
  });

  test('an already-aborted signal answers at once', async () => {
    const hub = createChangeHub(EPOCH);
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await hub.waitFor(0, EPOCH, 10_000, controller.signal);
    assert.ok(Date.now() - started < 500);
  });

  test('several waiters all wake on one event', async () => {
    const hub = createChangeHub(EPOCH);
    const waiters = [hub.waitFor(0, EPOCH, 10_000), hub.waitFor(0, EPOCH, 10_000)];
    hub.emit({ slug: 'a', kind: 'design' });
    for (const waiter of await Promise.all(waiters)) assert.equal(waiter.events.length, 1);
  });
});

describe('subscribe', () => {
  test('in-process listeners see every event and can unsubscribe', () => {
    const hub = createChangeHub(EPOCH);
    const seen: ChangeEvent[] = [];
    const unsubscribe = hub.subscribe((event) => seen.push(event));
    hub.emit({ slug: 'a', kind: 'design' });
    unsubscribe();
    hub.emit({ slug: 'b', kind: 'design' });
    assert.deepEqual(seen.map((event) => event.slug), ['a']);
  });
});
