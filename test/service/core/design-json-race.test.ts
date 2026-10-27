// Two-writer race on design.json (review 2026-10-27, M1; §6.3): a service write (add comment,
// rename, mark-sent) merges into design.json while the agent may be rewriting it. The mirror
// replaces the file only while it still holds the text it was merged from, so an agent write
// landing mid-merge is re-merged, never overwritten.

import assert from 'node:assert/strict';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { test } from 'node:test';

import type { Logger, SettingsStore } from '../../../src/service/context.ts';
import { createDesignStore } from '../../../src/service/store.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';

test('M1 — an agent design.json write concurrent with a comment is never lost', async (t) => {
  const tmp = await useTmpRoot(t);
  const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const settings: SettingsStore = {
    root: () => tmp.root,
    defaultRoot: () => tmp.root,
    read: () => ({ version: 1, root: tmp.root }),
    update: async () => {
      throw new Error('unused');
    },
    onRootChange: () => () => undefined,
  };
  const store = createDesignStore({ settings, log });
  const record = await store.create({ kind: 'canvas', title: 'Race' });
  const designFile = tmp.at(`${record.slug}/design.json`);

  let lost = 0;
  let failed = 0;
  let comments = 0;
  const rounds = 60;
  for (let round = 1; round <= rounds; round += 1) {
    const screens = Array.from({ length: round }, (_, n) => ({ id: `s${n}`, title: `S${n}`, file: `screens/s${n}.html` }));
    // The agent rewrites design.json (atomically, as a careful agent would) adding one screen.
    const agentWrite = (async () => {
      const current = JSON.parse(await readFile(designFile, 'utf8')) as Record<string, unknown>;
      const tmpFile = `${designFile}.agent.tmp`;
      await writeFile(tmpFile, JSON.stringify({ ...current, screens }, null, 2));
      await rename(tmpFile, designFile);
    })();
    const comment = store.addComment(record.slug, {
      screen: null,
      viewport: 'laptop',
      anchor: { selector: 'body', text: '', html: '', rect: { x: 0, y: 0, w: 1, h: 1 }, point: { x: 0, y: 0 } },
      body: `comment ${round}`,
    } as Parameters<typeof store.addComment>[1]);
    const [agentResult, commentResult] = await Promise.allSettled([agentWrite, comment]);
    if (commentResult.status === 'fulfilled') comments += 1;
    // Only count rounds where both writers succeeded: a lost write here is silent.
    if (agentResult.status === 'rejected' || commentResult.status === 'rejected') {
      failed += 1;
      continue;
    }
    const after = JSON.parse(await readFile(designFile, 'utf8')) as { screens?: unknown[] };
    if ((after.screens ?? []).length !== round) {
      lost += 1;
      // Put the agent's intent back so the next round starts from it (as the agent would retry).
      const fixed = JSON.parse(await readFile(designFile, 'utf8')) as Record<string, unknown>;
      await writeFile(designFile, JSON.stringify({ ...fixed, screens }, null, 2));
    }
  }
  assert.ok(failed < rounds / 2, `${failed} of ${rounds} rounds failed outright`);
  assert.equal(lost, 0, `${lost} of ${rounds - failed} agent writes to design.json were silently overwritten by a concurrent comment`);
  // Every comment the service accepted is still in state.json (the truth).
  const state = await store.get(record.slug);
  assert.equal(state.design.comments.length, comments);
});
