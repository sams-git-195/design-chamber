// Restore safety (review 2026-10-27, C1 + C2): a restore either completes from a version that
// stays intact, or refuses before writing anything when no restore point can be stored.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { createFakeContext } from '../../helpers/fake-context.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { ApiError } from '../../../src/service/http.ts';
import { createVersionsService } from '../../../src/service/versions.ts';
import { SNAPSHOT_FILES_MAX, VERSIONS_KEEP } from '../../../src/shared/limits.ts';
import { artifactDesign } from './harness.ts';

describe('version restore safety', () => {
  test('C1 — restoring the oldest version when the history is full restores it completely', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createFakeContext({ root: tmp.root });
    t.after(() => ctx.dispose());
    const versions = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, quietMs: 60_000 });

    await tmp.writeDesign('art', artifactDesign({ 'index.html': '<p>oldest-unique</p>' }));
    const oldest = await versions.create('art', 'manual');
    assert.ok(oldest);
    for (let n = 2; n <= VERSIONS_KEEP; n += 1) {
      await tmp.write('art/index.html', `<p>edit ${n}</p>`);
      assert.ok(await versions.create('art', 'manual'));
    }
    // Dirty design: the restore takes a restore point first, which must not prune the target.
    await tmp.write('art/index.html', '<p>unsaved work</p>');

    const result = await versions.restore('art', oldest.id);
    assert.equal(await readFile(tmp.at('art/index.html'), 'utf8'), '<p>oldest-unique</p>');
    assert.ok(result.restorePoint, 'the unsaved work is kept as a restore point');
    const listed = await versions.list('art');
    assert.ok(listed.versions.length <= VERSIONS_KEEP);
    assert.equal(listed.dirty, false);
    // The restore point holds the unsaved work and can be restored back.
    await versions.restore('art', result.restorePoint.id);
    assert.equal(await readFile(tmp.at('art/index.html'), 'utf8'), '<p>unsaved work</p>');
  });

  test('C2 — a design too large for a restore point refuses the restore and changes nothing', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createFakeContext({ root: tmp.root });
    t.after(() => ctx.dispose());
    const versions = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, quietMs: 60_000 });

    await tmp.writeDesign('art', artifactDesign());
    const v1 = await versions.create('art', 'manual');
    assert.ok(v1);
    // The agent later edits the page and adds more assets than a snapshot may hold.
    await tmp.write('art/index.html', '<p>newer page</p>');
    for (let n = 0; n <= SNAPSHOT_FILES_MAX; n += 1) await tmp.write(`art/assets/a${n}.txt`, `asset ${n}`);

    await assert.rejects(versions.restore('art', v1.id), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, 'invalid');
      assert.match(error.message, /too large to keep a restore point/);
      return true;
    });
    assert.equal(await readFile(tmp.at('art/assets/a0.txt'), 'utf8'), 'asset 0');
    assert.equal(await readFile(tmp.at(`art/assets/a${SNAPSHOT_FILES_MAX}.txt`), 'utf8'), `asset ${SNAPSHOT_FILES_MAX}`);
    assert.equal(await readFile(tmp.at('art/index.html'), 'utf8'), '<p>newer page</p>');
    assert.equal((await versions.list('art')).versions.length, 1);
  });
});
