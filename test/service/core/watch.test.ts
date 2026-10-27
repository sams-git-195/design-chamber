// The watcher and the §6.3 merge under it (docs/SPEC.md §9.4, §4.8, SPEC §14 WP1):
// fs.watch fast path + poll backstop, per-slug debounce, ignored service-owned paths,
// root switching, and the acceptance pair — an agent overwrite that drops the comments is
// re-merged within 1 s, and the merge itself never loops.

import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import type { FSWatcher } from 'node:fs';

import { createChangeHub } from '../../../src/service/changes.ts';
import { createDesignStore } from '../../../src/service/store.ts';
import { startWatcher, type Watcher } from '../../../src/service/watch.ts';
import type { ChangeHub, Logger, SettingsStore } from '../../../src/service/context.ts';
import { WATCH_POLL_MS } from '../../../src/shared/limits.ts';
import type { ChangeEvent, ChangeKind } from '../../../src/shared/types.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';
import type { LogLine } from './harness.ts';

type WatchEnv = {
  tmp: TmpRoot;
  logs: LogLine[];
  hub: ChangeHub;
  events: ChangeEvent[];
  settings: SettingsStore;
  watcher: Watcher;
  setRoot(next: string): void;
  root(): string;
  waitForEvent(predicate: (event: ChangeEvent) => boolean, timeoutMs?: number): Promise<ChangeEvent>;
  quietFor(ms: number): Promise<void>;
};

const makeWatchEnv = async (
  t: TestContext,
  options: { debounceMs?: number; pollMs?: number; watchImpl?: typeof import('node:fs').watch; withStore?: boolean } = {},
): Promise<WatchEnv & { store?: ReturnType<typeof createDesignStore> }> => {
  const tmp = await useTmpRoot(t);
  const logs: LogLine[] = [];
  const log: Logger = {
    info: (event, fields) => void logs.push({ level: 'info', event, fields }),
    warn: (event, fields) => void logs.push({ level: 'warn', event, fields }),
    error: (event, fields) => void logs.push({ level: 'error', event, fields }),
  };
  const hub = createChangeHub(randomUUID());
  const events: ChangeEvent[] = [];
  hub.subscribe((event) => events.push(event));

  let currentRoot = tmp.root;
  const rootListeners = new Set<(next: string, previous: string) => void>();
  const settings: SettingsStore = {
    root: () => currentRoot,
    defaultRoot: () => currentRoot,
    read: () => ({ version: 1, root: currentRoot }),
    async update() {
      throw new Error('not used in watch tests');
    },
    onRootChange(listener) {
      rootListeners.add(listener);
      return () => rootListeners.delete(listener);
    },
  };

  const store = options.withStore ? createDesignStore({ settings, log, hub }) : undefined;
  const watcher = startWatcher({
    settings,
    hub,
    log,
    debounceMs: options.debounceMs ?? 50,
    pollMs: options.pollMs ?? WATCH_POLL_MS,
    ...(options.watchImpl ? { watchImpl: options.watchImpl } : {}),
  });
  t.after(() => watcher.stop());

  const waitForEvent = async (predicate: (event: ChangeEvent) => boolean, timeoutMs = 4000): Promise<ChangeEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(`Timed out after ${timeoutMs} ms waiting for an event; saw: ${JSON.stringify(events)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  return {
    tmp,
    logs,
    hub,
    events,
    settings,
    watcher,
    store,
    root: () => currentRoot,
    setRoot(next: string) {
      const previous = currentRoot;
      currentRoot = next;
      for (const listener of [...rootListeners]) listener(next, previous);
    },
    waitForEvent,
    quietFor: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
};

/** A dead fs.watch stand-in so only the poll backstop can produce events. */
const deadWatch = (() => {
  const fake = { close() {}, on: () => fake, once: () => fake, emit: () => false, ref: () => fake, unref: () => fake };
  return fake as unknown as FSWatcher;
}) as unknown as typeof import('node:fs').watch;

describe('watcher events', () => {
  test('a new design folder emits "added", file writes emit "files", design.json emits "design", deletion emits "removed"', async (t) => {
    const env = await makeWatchEnv(t, { pollMs: 600_000 }); // isolate the fs.watch fast path
    await env.quietFor(150); // let the seed scan settle

    await mkdir(env.tmp.at('demo'), { recursive: true });
    await env.waitForEvent((event) => event.slug === 'demo' && event.kind === 'added');

    await writeFile(env.tmp.at('demo/index.html'), '<h1>one</h1>', 'utf8');
    const files = await env.waitForEvent((event) => event.slug === 'demo' && event.kind === 'files');
    assert.deepEqual(files.files, ['index.html']);

    await writeFile(env.tmp.at('demo/design.json'), '{"version":1}', 'utf8');
    await env.waitForEvent((event) => event.slug === 'demo' && event.kind === 'design');

    await mkdir(env.tmp.at('demo/screens'), { recursive: true });
    await writeFile(env.tmp.at('demo/screens/home.html'), '<h1>home</h1>', 'utf8');
    const nested = await env.waitForEvent((event) => event.slug === 'demo' && event.kind === 'files' && (event.files ?? []).includes('screens/home.html'));
    assert.ok(nested.seq > files.seq);

    await rm(env.tmp.at('demo'), { recursive: true, force: true });
    await env.waitForEvent((event) => event.slug === 'demo' && event.kind === 'removed');
  });

  test('service-owned paths are ignored: .chamber/, .versions/, .thumb.png, tmp files, .trash/', async (t) => {
    const env = await makeWatchEnv(t, { pollMs: 600_000 });
    await mkdir(env.tmp.at('demo'), { recursive: true });
    await env.waitForEvent((event) => event.slug === 'demo' && event.kind === 'added');
    const mark = env.hub.seq();

    await mkdir(env.tmp.at('demo/.chamber'), { recursive: true });
    await writeFile(env.tmp.at('demo/.chamber/state.json'), '{}', 'utf8');
    await mkdir(env.tmp.at('demo/.versions'), { recursive: true });
    await writeFile(env.tmp.at('demo/.versions/index.json'), '{}', 'utf8');
    await writeFile(env.tmp.at('demo/.thumb.png'), 'PNG', 'utf8');
    await writeFile(env.tmp.at('demo/.design.json.tmp-42-abc'), 'partial', 'utf8');
    await mkdir(env.tmp.at('.trash/old-1'), { recursive: true });
    await writeFile(env.tmp.at('.trash/old-1/design.json'), '{}', 'utf8');

    await env.quietFor(500); // five debounce windows: nothing may arrive
    const late = env.events.filter((event) => event.seq > mark);
    assert.deepEqual(late, [], `unexpected events: ${JSON.stringify(late)}`);
  });

  test('the poll backstop delivers changes when fs.watch is dead (OneDrive/network roots)', async (t) => {
    const env = await makeWatchEnv(t, { watchImpl: deadWatch, pollMs: 120 });
    await mkdir(env.tmp.at('polled'), { recursive: true });
    await env.waitForEvent((event) => event.slug === 'polled' && event.kind === 'added', 6000);

    await writeFile(env.tmp.at('polled/design.json'), '{"version":1}', 'utf8');
    await env.waitForEvent((event) => event.slug === 'polled' && event.kind === 'design', 6000);

    await mkdir(env.tmp.at('polled/screens'), { recursive: true });
    await writeFile(env.tmp.at('polled/screens/a.html'), '<h1>a</h1>', 'utf8');
    const files = await env.waitForEvent((event) => event.slug === 'polled' && event.kind === 'files' && (event.files ?? []).includes('screens/a.html'), 6000);
    assert.ok(files.seq > 0);
  });

  test('poll-only roots: the service\'s own dot writes emit nothing; a new top-level file is named (KI-1)', async (t) => {
    const env = await makeWatchEnv(t, { watchImpl: deadWatch, pollMs: 120 });
    await mkdir(env.tmp.at('polled/screens'), { recursive: true });
    await writeFile(env.tmp.at('polled/screens/home.html'), '<p>home</p>', 'utf8');
    await env.waitForEvent((event) => event.slug === 'polled' && event.kind === 'added', 6000);
    await env.quietFor(500);
    const mark = env.hub.seq();

    // Exactly what thumbnails.ts does when it publishes a capture, and a mirror tmp file.
    const thumbTmp = env.tmp.at(`polled/.thumb.${Date.now()}.png`);
    await writeFile(thumbTmp, 'png');
    await rename(thumbTmp, env.tmp.at('polled/.thumb.png'));
    await writeFile(env.tmp.at('polled/.design.json.tmp-1-x'), '{}', 'utf8');
    await env.quietFor(800);
    const late = env.events.filter((event) => event.seq > mark && event.slug === 'polled');
    assert.deepEqual(late, [], `a service dot write is not a content change: ${JSON.stringify(late)}`);

    await writeFile(env.tmp.at('polled/notes.txt'), 'new', 'utf8');
    const added = await env.waitForEvent((event) => event.seq > mark && event.slug === 'polled' && event.kind === 'files', 6000);
    assert.deepEqual(added.files, ['notes.txt']);
  });

  test('a root switch emits "root", follows the new root and ignores the old one', async (t) => {
    const env = await makeWatchEnv(t, { pollMs: 600_000 });
    await mkdir(env.tmp.at('old-root-design'), { recursive: true });
    await mkdir(env.tmp.at('root-b'), { recursive: true });
    await env.waitForEvent((event) => event.slug === 'old-root-design' && event.kind === 'added');

    env.setRoot(env.tmp.at('root-b'));
    await env.waitForEvent((event) => event.slug === null && event.kind === 'root');

    await mkdir(env.tmp.at('root-b/new-design'), { recursive: true });
    await env.waitForEvent((event) => event.slug === 'new-design' && event.kind === 'added');

    const mark = env.hub.seq();
    await writeFile(env.tmp.at('old-root-design/index.html'), '<h1>ignored</h1>', 'utf8');
    await env.quietFor(400);
    assert.deepEqual(env.events.filter((event) => event.seq > mark && event.slug === 'old-root-design'), []);
  });
});

describe('fs.watch that cannot work here (Linux inotify limit, no recursive support)', () => {
  const failing = (code: string, how: 'throw' | 'emit') => {
    let calls = 0;
    const impl = (() => {
      calls += 1;
      const error = Object.assign(new Error(`${code}: System limit for number of file watchers reached, watch`), { code });
      if (how === 'throw') throw error;
      let onError: ((error: Error) => void) | null = null;
      const fake = {
        close() {},
        on(event: string, listener: (error: Error) => void) {
          if (event === 'error') {
            onError = listener;
            setTimeout(() => onError?.(error), 5);
          }
          return fake;
        },
      };
      return fake as unknown as FSWatcher;
    }) as unknown as typeof import('node:fs').watch;
    return { impl, calls: () => calls };
  };

  for (const [code, how] of [
    ['ENOSPC', 'emit'],
    ['ENOSPC', 'throw'],
    ['ERR_FEATURE_UNAVAILABLE_ON_PLATFORM', 'throw'],
  ] as const) {
    test(`${code} (${how}): logged once as poll-only, never retried, and the poll backstop keeps the list live`, async (t) => {
      const watch = failing(code, how);
      const env = await makeWatchEnv(t, { watchImpl: watch.impl, pollMs: 100 });
      await env.quietFor(150); // let the seed scan settle, or it may adopt the folder silently
      await mkdir(env.tmp.at('polled'), { recursive: true });
      await env.waitForEvent((event) => event.slug === 'polled' && event.kind === 'added', 6000);
      await writeFile(env.tmp.at('polled/index.html'), '<h1>x</h1>', 'utf8');
      await env.waitForEvent((event) => event.slug === 'polled' && event.kind === 'files', 6000);
      await env.quietFor(350); // several more poll ticks
      assert.equal(watch.calls(), 1, 'a permanent failure is not retried every poll tick');
      assert.deepEqual(env.logs.map((line) => `${line.level}:${line.event}`), ['info:watch.poll-only']);
    });
  }

  test('a transient failure is still retried by the poll tick', async (t) => {
    const watch = failing('EMFILE', 'throw');
    const env = await makeWatchEnv(t, { watchImpl: watch.impl, pollMs: 60 });
    await env.quietFor(400);
    assert.ok(watch.calls() > 1, `retried (${watch.calls()} calls)`);
    assert.deepEqual(env.logs.filter((line) => line.event.startsWith('watch.')).map((line) => `${line.level}:${line.event}`), ['warn:watch.unavailable'], 'logged once');
  });

  test('a root switch gives fs.watch another chance', async (t) => {
    const watch = failing('ENOSPC', 'throw');
    const env = await makeWatchEnv(t, { watchImpl: watch.impl, pollMs: 60 });
    await env.quietFor(200);
    assert.equal(watch.calls(), 1);
    await mkdir(env.tmp.at('root-b'), { recursive: true });
    env.setRoot(env.tmp.at('root-b'));
    await env.quietFor(50);
    assert.equal(watch.calls(), 2);
  });
});

describe('design.json merge under the watcher (§6.3, WP1 acceptance)', () => {
  test('an agent overwrite that dropped the comments is re-merged within 1 s', async (t) => {
    const env = await makeWatchEnv(t, { debounceMs: 250, pollMs: 600_000, withStore: true });
    const store = env.store;
    assert.ok(store);
    const created = await store.create({ kind: 'canvas', title: 'Live merge' });
    const comment = await store.addComment(created.slug, {
      screen: null,
      viewport: 'laptop',
      anchor: { selector: 'main > h1', text: 'Ship faster', html: '<h1>', rect: { x: 1, y: 2, w: 3, h: 4 }, point: { x: 0.5, y: 0.5 } },
      body: 'Keep me',
    });
    await env.quietFor(500); // let the watcher digest the service's own writes

    // The agent rewrites design.json wholesale — comments gone, title changed, unknown key added.
    const designFile = path.join(created.path, 'design.json');
    const started = Date.now();
    await writeFile(
      designFile,
      JSON.stringify({
        version: 1,
        kind: 'canvas',
        title: 'Agent retitled',
        created: '2020-01-01T00:00:00.000Z',
        updated: new Date().toISOString(),
        viewports: [{ id: 'laptop', label: 'Laptop', width: 1280, height: 800 }],
        screens: [],
        designSystem: { confirmed: true },
        agentExtra: 'kept',
      }),
      'utf8',
    );

    let mergedText = '';
    const deadline = started + 4000;
    for (;;) {
      mergedText = await readFile(designFile, 'utf8');
      if (mergedText.includes(comment.id)) break;
      if (Date.now() > deadline) throw new Error(`design.json was never re-merged; last content: ${mergedText}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1000, `re-merge took ${elapsed} ms, over the 1 s acceptance budget`);

    const merged = JSON.parse(mergedText) as Record<string, unknown>;
    assert.equal(merged.title, 'Agent retitled');
    assert.equal(merged.agentExtra, 'kept');
    assert.equal(merged.created, created.design.created); // service-owned: state.json wins
    assert.equal((merged.comments as unknown[]).length, 1);
  });

  test('the merge never loops: one rewrite, then silence', async (t) => {
    const env = await makeWatchEnv(t, { debounceMs: 120, pollMs: 600_000, withStore: true });
    const store = env.store;
    assert.ok(store);
    const created = await store.create({ kind: 'canvas', title: 'No loop' });
    await store.addComment(created.slug, {
      screen: null,
      viewport: 'laptop',
      anchor: { selector: 'h1', text: 'x', html: '<h1>', rect: { x: 0, y: 0, w: 1, h: 1 }, point: { x: 0.5, y: 0.5 } },
      body: 'Pin',
    });
    await env.quietFor(400);

    const designFile = path.join(created.path, 'design.json');
    await writeFile(designFile, JSON.stringify({ version: 1, kind: 'canvas', title: 'Dropped everything' }), 'utf8');
    await env.waitForEvent((event) => event.slug === created.slug && event.kind === 'design');
    // Wait for the merge write to land…
    const merged = await new Promise<string>((resolve) => {
      const poll = (): void => {
        void readFile(designFile, 'utf8').then((text) => {
          if (text.includes('Dropped everything') && text.includes('comments')) resolve(text);
          else setTimeout(poll, 20);
        });
      };
      poll();
    });
    assert.ok(merged.includes('comments'));
    const afterMerge = await stat(designFile);

    await env.quietFor(900); // ~7 debounce windows of silence
    const still = await stat(designFile);
    assert.equal(still.mtimeMs, afterMerge.mtimeMs, 'design.json must not be rewritten again');
    assert.equal(await readFile(designFile, 'utf8'), merged);
    assert.equal(env.logs.filter((line) => line.event === 'store.design-json-remerged').length, 1, 'exactly one re-merge write, then silence');
  });
});
