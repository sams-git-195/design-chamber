// Folders under the designs root that are not designs (review 2026-10-27, M2; §6.1): only a
// folder with design.json, .chamber/state.json, index.html or screens/ is a design. Anything
// else is the user's own folder — never listed, reconciled, snapshotted or written into.

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { test, type TestContext } from 'node:test';

import { createChangeHub } from '../../../src/service/changes.ts';
import type { Logger, SettingsStore } from '../../../src/service/context.ts';
import { ApiError } from '../../../src/service/http.ts';
import { createDesignStore } from '../../../src/service/store.ts';
import { createVersionsService } from '../../../src/service/versions.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';

const setup = async (t: TestContext) => {
  const tmp: TmpRoot = await useTmpRoot(t);
  const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const hub = createChangeHub(randomUUID());
  const settings: SettingsStore = {
    root: () => tmp.root,
    defaultRoot: () => tmp.root,
    read: () => ({ version: 1, root: tmp.root }),
    update: async () => {
      throw new Error('unused');
    },
    onRootChange: () => () => undefined,
  };
  const store = createDesignStore({ settings, log, hub });
  const disposers: (() => void | Promise<void>)[] = [];
  const versions = createVersionsService({ store, hub, log, onDispose: (fn) => void disposers.push(fn), quietMs: 60_000 });
  t.after(async () => {
    for (const fn of disposers) await fn();
  });
  return { tmp, store, versions };
};

const isNotFound = (error: unknown): boolean => error instanceof ApiError && error.code === 'not-found';

test('M2 — a non-design folder under the root (user picked Documents as the root) is never written into', async (t) => {
  const { tmp, store, versions } = await setup(t);
  // The user's own folder, e.g. Documents/notes, after they chose Documents as the designs root.
  await tmp.write('notes/todo.txt', 'buy milk');
  await tmp.write('notes/journal/2026.md', '# private');

  // What the watcher does when the user edits a file in that folder (`files`) or it first appears (`added`).
  await store.reconcile('notes');
  await assert.rejects(versions.snapshot('notes', 'auto'), isNotFound);
  await assert.rejects(store.get('notes'), isNotFound);
  await assert.rejects(store.trash('notes'), isNotFound);
  await assert.rejects(store.addComment('notes', { screen: null, viewport: 'laptop', anchor: { selector: 'body', text: '', html: '', rect: { x: 0, y: 0, w: 1, h: 1 }, point: { x: 0, y: 0 } }, body: 'x' } as Parameters<typeof store.addComment>[1]), isNotFound);

  assert.deepEqual((await readdir(tmp.at('notes'))).sort(), ['journal', 'todo.txt'], 'Design Chamber wrote service folders into a folder that is not a design');
  assert.deepEqual(await store.list(), []);
});

test('M2 — folders the agent started (index.html only, screens/ only) and service-created ones are still designs', async (t) => {
  const { tmp, store } = await setup(t);
  await tmp.write('html-first/index.html', '<p>agent wrote the HTML first</p>');
  await tmp.write('screens-first/screens/home.html', '<p>home</p>');
  await tmp.write('notes/todo.txt', 'buy milk');
  const created = await store.create({ kind: 'canvas', title: 'Made here' });

  const listed = (await store.list()).map((summary) => summary.slug).sort();
  assert.deepEqual(listed, ['html-first', created.slug, 'screens-first'].sort());
  assert.equal((await store.get('html-first')).design.kind, 'artifact');
});
