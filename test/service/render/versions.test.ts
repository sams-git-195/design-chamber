import assert from 'node:assert/strict';
import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createFakeContext, type FakeContext } from '../../helpers/fake-context.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';
import { createVersionsService, EMPTY_TREE_HASH, isTracked, listTracked, type VersionsService } from '../../../src/service/versions.ts';
import { ApiError } from '../../../src/service/http.ts';
import { artifactDesign, sleep } from './harness.ts';

const setup = async (t: TestContext, quietMs = 40): Promise<{ tmp: TmpRoot; ctx: FakeContext; versions: VersionsService }> => {
  const tmp = await useTmpRoot(t);
  const ctx = createFakeContext({ root: tmp.root });
  t.after(() => ctx.dispose());
  const versions = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, quietMs });
  return { tmp, ctx, versions };
};

const indexFile = (tmp: TmpRoot, slug: string): string => tmp.at(`${slug}/.versions/index.json`);
const objectsDir = (tmp: TmpRoot, slug: string): string => tmp.at(`${slug}/.versions/objects`);

const allObjects = async (dir: string): Promise<string[]> => {
  const buckets = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const hashes: string[] = [];
  for (const bucket of buckets) {
    if (!bucket.isDirectory()) continue;
    for (const name of await readdir(path.join(dir, bucket.name))) hashes.push(name);
  }
  return hashes;
};

describe('tracked set', () => {
  test('versions, chamber and thumbnails are excluded; everything else is tracked', () => {
    assert.equal(isTracked('index.html'), true);
    assert.equal(isTracked('assets/pic.png'), true);
    assert.equal(isTracked('DESIGN.md'), true);
    assert.equal(isTracked('.versions/index.json'), false);
    assert.equal(isTracked('.chamber/state.json'), false);
    assert.equal(isTracked('.thumb.png'), false);
    assert.equal(isTracked('.thumb.123.png'), false);
    assert.equal(isTracked('sub/.thumb.png'), false);
  });

  test('listTracked walks the folder and skips the excluded trees', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('art', {
      ...artifactDesign(),
      'assets/pic.png': 'x',
      '.chamber/state.json': '{}',
      '.versions/index.json': '{}',
      '.thumb.png': 'x',
    });
    const rels = await listTracked(tmp.at('art'));
    assert.deepEqual(rels, ['assets/pic.png', 'design.json', 'index.html']);
  });
});

describe('versions', () => {
  test('manual snapshot creates v1, dedupes an unchanged tree, and lists newest-first', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());

    const first = await versions.create('art', 'manual');
    assert.ok(first);
    assert.equal(first.id, 'v1');
    assert.equal(first.n, 1);
    assert.equal(first.reason, 'manual');
    assert.equal(first.fileCount, 2); // design.json + index.html

    const again = await versions.create('art', 'manual');
    assert.equal(again, null, 'an unchanged tree is deduped by hash');

    const list = await versions.list('art');
    assert.equal(list.versions.length, 1);
    assert.equal(list.dirty, false);
    assert.equal(list.currentTreeHash, first.treeHash);

    await tmp.write('art/index.html', '<p>changed</p>');
    const dirty = await versions.list('art');
    assert.equal(dirty.dirty, true, 'a content change makes the tree dirty');

    const second = await versions.create('art', 'manual', { label: 'after edit' });
    assert.ok(second);
    assert.equal(second.id, 'v2');
    assert.equal(second.label, 'after edit');
    const list2 = await versions.list('art');
    assert.deepEqual(
      list2.versions.map((entry) => entry.id),
      ['v2', 'v1'],
      'newest first',
    );
    assert.equal(list2.dirty, false);
  });

  test('design.json is stored with comments removed and sessionId kept', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', {
      ...artifactDesign(),
      'design.json': {
        version: 1,
        kind: 'artifact',
        title: 'T',
        created: '2026-10-26T10:00:00.000Z',
        updated: '2026-10-26T10:00:00.000Z',
        sessionId: 'ses_abc',
        comments: [{ id: 'c_abcd', screen: null, viewport: 'laptop', anchor: { selector: 'h1', text: 'x', html: '<h1>', rect: { x: 0, y: 0, w: 1, h: 1 }, point: { x: 0, y: 0 } }, body: 'secret pin', status: 'open', created: '2026-10-26T10:00:00.000Z', sentAt: null, sentVersion: null }],
      },
    });
    const created = await versions.create('art', 'manual');
    assert.ok(created);
    const index = JSON.parse(await readFile(indexFile(tmp, 'art'), 'utf8')) as { versions: { files: Record<string, string> }[] };
    const hash = index.versions[0]?.files['design.json'];
    assert.ok(hash);
    const stored = await readFile(path.join(objectsDir(tmp, 'art'), hash.slice(0, 2), hash), 'utf8');
    assert.ok(!stored.includes('secret pin'), 'comments are stripped from the stored design.json');
    assert.ok(stored.includes('ses_abc'), 'other fields survive');
  });

  test('auto snapshot fires after the quiet period and is deduped when nothing changed', async (t) => {
    const { tmp, ctx, versions } = await setup(t, 40);
    await tmp.writeDesign('art', artifactDesign());
    await versions.create('art', 'manual'); // v1

    await tmp.write('art/index.html', '<p>agent wrote</p>');
    ctx.hub.emit({ slug: 'art', kind: 'files', files: ['index.html'] });
    assert.equal(versions.autoPending('art'), true);
    await sleep(200);
    const list = await versions.list('art');
    assert.equal(list.versions.length, 2);
    assert.equal(list.versions[0]?.reason, 'auto');
    assert.equal(list.dirty, false);

    // An event with no content change dedupes: no v3.
    ctx.hub.emit({ slug: 'art', kind: 'files', files: ['index.html'] });
    await sleep(200);
    assert.equal((await versions.list('art')).versions.length, 2);
  });

  test('turn snapshot captures every design linked to the session and dedupes within the window', async (t) => {
    const { tmp, versions } = await setup(t);
    const design = (title: string, sessionId: string) => ({
      ...artifactDesign(),
      'design.json': { version: 1, kind: 'artifact', title, created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z', sessionId },
    });
    await tmp.writeDesign('one', design('One', 'ses_x'));
    await tmp.writeDesign('two', design('Two', 'ses_x'));
    await tmp.writeDesign('three', design('Three', 'ses_y'));

    const created = await versions.turn('ses_x');
    assert.deepEqual(created.map((entry) => entry.slug).sort(), ['one', 'two']);
    assert.ok(created.every((entry) => entry.id === 'v1'));

    // Same session within 2 s collapses into one run even though content changed.
    await tmp.write('one/index.html', '<p>more</p>');
    const collapsed = await versions.turn('ses_x');
    assert.deepEqual(collapsed, created, 'the dedupe window answers the first run');
    await sleep(2100);
    const after = await versions.turn('ses_x');
    assert.equal(after.length, 1, 'after the window the change is captured');
    assert.equal(after[0]?.slug, 'one');
  });

  test('a turn that ends after the quiet-period auto snapshot promotes that auto version to "turn"', async (t) => {
    const { tmp, ctx, versions } = await setup(t, 40);
    await tmp.writeDesign('art', {
      ...artifactDesign(),
      'design.json': { version: 1, kind: 'artifact', title: 'Art', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z', sessionId: 'ses_x' },
    });
    await versions.create('art', 'manual'); // v1
    await tmp.write('art/index.html', '<p>agent wrote</p>');
    ctx.hub.emit({ slug: 'art', kind: 'files', files: ['index.html'] });
    await sleep(200);
    assert.equal((await versions.list('art')).versions[0]?.reason, 'auto', 'v2 is the auto snapshot');

    const turned = await versions.turn('ses_x');
    assert.deepEqual(turned.map((entry) => entry.id), ['v2'], 'no duplicate version: v2 is the turn result');
    const list = await versions.list('art');
    assert.deepEqual(list.versions.map((entry) => `${entry.id}:${entry.reason}`), ['v2:turn', 'v1:manual']);

    // A manual version with the same files is never relabelled.
    await sleep(2100);
    await tmp.write('art/index.html', '<p>by hand</p>');
    await versions.create('art', 'manual'); // v3
    assert.deepEqual(await versions.turn('ses_x'), []);
    assert.equal((await versions.list('art')).versions[0]?.reason, 'manual');
  });

  test('restore writes the old tree back, deletes extra files, and records restore-point + restored', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', {
      ...artifactDesign(),
      'design.json': {
        version: 1,
        kind: 'artifact',
        title: 'Original title',
        created: '2026-10-26T10:00:00.000Z',
        updated: '2026-10-26T10:00:00.000Z',
      },
    });
    const v1 = await versions.create('art', 'manual');
    assert.ok(v1);

    // The agent rewrites and adds files, then a manual snapshot pins that state.
    await tmp.write('art/index.html', '<p>rewrite</p>');
    await tmp.write('art/extra.txt', 'added later');
    await tmp.write(
      'art/design.json',
      JSON.stringify({ version: 1, kind: 'artifact', title: 'Renamed by agent', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T11:00:00.000Z' }),
    );
    const v2 = await versions.create('art', 'manual');
    assert.ok(v2);

    // A dirty change with no snapshot → restore must save it as the restore-point.
    await tmp.write('art/index.html', '<p>unsaved edit</p>');
    const result = await versions.restore('art', 'v1');
    assert.ok(result.restorePoint, 'the unsaved state was saved first');
    assert.equal(result.restorePoint.reason, 'restore-point');
    assert.equal(result.restored.reason, 'restored');

    const restoredHtml = await readFile(tmp.at('art/index.html'), 'utf8');
    assert.ok(restoredHtml.includes('<h1>hello</h1>'), 'the v1 entry HTML is back');
    const restoredDesign = JSON.parse(await readFile(tmp.at('art/design.json'), 'utf8')) as { title: string };
    assert.equal(restoredDesign.title, 'Original title');
    const extra = await readFile(tmp.at('art/extra.txt'), 'utf8').catch(() => null);
    assert.equal(extra, null, 'files added after the version are deleted');

    const list = await versions.list('art');
    assert.equal(list.dirty, false, 'the restored tree matches the newest version');
    assert.deepEqual(
      list.versions.map((entry) => entry.reason),
      ['restored', 'restore-point', 'manual', 'manual'],
    );
    assert.equal(list.versions[0]?.treeHash, v1.treeHash, 'the restored snapshot has the v1 tree hash');
  });

  test('restore keeps CURRENT comments and sessionId (never taken from the snapshot)', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    await versions.create('art', 'manual'); // v1: no session, no comments

    // WP1's state.json is the truth for service-owned fields; simulate a later link + comment.
    await tmp.write(
      'art/.chamber/state.json',
      JSON.stringify({
        version: 1,
        kind: 'artifact',
        created: '2026-10-26T10:00:00.000Z',
        brief: '',
        sessionId: 'ses_now',
        projectDirectory: null,
        preset: null,
        entry: 'index.html',
        comments: [
          { id: 'c_now1', screen: null, viewport: 'laptop', anchor: { selector: 'h1', text: 'hello', html: '<h1>', rect: { x: 0, y: 0, w: 10, h: 10 }, point: { x: 0.5, y: 0.5 } }, body: 'keep me', status: 'open', created: '2026-10-26T12:00:00.000Z', sentAt: null, sentVersion: null },
        ],
      }),
    );
    await tmp.write('art/index.html', '<p>agent changed it</p>');
    await versions.create('art', 'manual'); // v2

    await versions.restore('art', 'v1');
    const design = JSON.parse(await readFile(tmp.at('art/design.json'), 'utf8')) as { sessionId: string | null; comments: { id: string }[] };
    assert.equal(design.sessionId, 'ses_now', 'the current session link survives the restore');
    assert.deepEqual(
      design.comments.map((comment) => comment.id),
      ['c_now1'],
      'the current comments survive the restore',
    );
    assert.ok((await readFile(tmp.at('art/index.html'), 'utf8')).includes('<h1>hello</h1>'), 'agent content was restored');
  });

  test('restoring the newest version is a no-op that still answers the version', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    const v1 = await versions.create('art', 'manual');
    assert.ok(v1);
    const result = await versions.restore('art', 'v1');
    assert.equal(result.restorePoint, null, 'nothing unsaved → no restore-point');
    assert.equal(result.restored.id, 'v1', 'the existing version is answered, no duplicate entry');
    assert.equal((await versions.list('art')).versions.length, 1);
  });

  test('diff against current and against another version', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    await versions.create('art', 'manual'); // v1
    await tmp.write('art/index.html', '<p>changed</p>');
    await tmp.write('art/added.txt', 'new');
    await versions.create('art', 'manual'); // v2
    await tmp.write('art/index.html', '<p>changed again</p>');

    const againstCurrent = await versions.diff('art', 'v1', 'current');
    assert.deepEqual(againstCurrent.files, [
      { path: 'added.txt', change: 'added' },
      { path: 'index.html', change: 'modified' },
    ]);

    const v1v2 = await versions.diff('art', 'v1', 'v2');
    assert.deepEqual(v1v2.files, [
      { path: 'added.txt', change: 'added' },
      { path: 'index.html', change: 'modified' },
    ]);
    const same = await versions.diff('art', 'v2', 'v2');
    assert.deepEqual(same.files, []);
  });

  test('prune keeps the newest 100 versions and GC removes unreferenced objects', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', { 'index.html': 'seed 0' });
    for (let i = 1; i <= 105; i += 1) {
      await tmp.write('art/index.html', `seed ${i}`);
      const created = await versions.create('art', 'manual');
      assert.ok(created, `snapshot ${i}`);
    }
    const list = await versions.list('art');
    assert.equal(list.versions.length, 100, 'the oldest versions are pruned');
    assert.equal(list.versions[0]?.n, 105);
    assert.equal(list.versions[99]?.n, 6, 'pruning keeps the newest window');

    const referenced = new Set<string>();
    const index = JSON.parse(await readFile(indexFile(tmp, 'art'), 'utf8')) as { versions: { files: Record<string, string> }[] };
    for (const entry of index.versions) for (const hash of Object.values(entry.files)) referenced.add(hash);
    const objects = await allObjects(objectsDir(tmp, 'art'));
    for (const hash of objects) assert.ok(referenced.has(hash), `object ${hash} is still referenced`);
    assert.ok(objects.length < 110, 'orphaned seed objects were collected');
  });

  test('unknown ids and damaged versions are refused with user-facing errors', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    await versions.create('art', 'manual');
    await assert.rejects(versions.restore('art', 'v9'), ApiError);
    await assert.rejects(versions.diff('art', 'nope', 'current'), ApiError);
    await assert.rejects(versions.readTree('art', 'v9'), ApiError);

    // A deleted object makes the version unrestorable — but the refusal happens BEFORE any write.
    const objects = await allObjects(objectsDir(tmp, 'art'));
    const victim = objects[0];
    assert.ok(victim);
    await rm(path.join(objectsDir(tmp, 'art'), victim.slice(0, 2), victim));
    await assert.rejects(versions.restore('art', 'v1'), /damaged/);
    assert.ok((await readFile(tmp.at('art/index.html'), 'utf8')).includes('hello'), 'nothing was written');
  });

  test('a tampered index.json cannot make restore read or write outside the design folder', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    const created = await versions.create('art', 'manual');
    assert.ok(created);
    const index = JSON.parse(await readFile(indexFile(tmp, 'art'), 'utf8')) as { versions: { files: Record<string, string> }[] };
    const entry = index.versions[0];
    assert.ok(entry);
    const hash = Object.values(entry.files)[0];
    assert.ok(hash);
    const tampered: Record<string, string>[] = [{ '../escaped.txt': hash }, { 'C:/escaped.txt': hash }, { 'index.html': '../../../../etc/passwd' }];
    for (const files of tampered) {
      entry.files = files;
      await tmp.write('art/.versions/index.json', index);
      await assert.rejects(versions.restore('art', created.id), ApiError);
    }
    await assert.rejects(readFile(tmp.at('escaped.txt')), 'nothing was written next to the design');
    assert.ok((await readFile(tmp.at('art/index.html'), 'utf8')).includes('hello'), 'the design is untouched');
  });

  test('an empty design folder has the empty tree hash and is not dirty', async (t) => {
    const { tmp, versions } = await setup(t);
    await tmp.write('art/placeholder.txt', '');
    await rm(tmp.at('art/placeholder.txt'));
    const list = await versions.list('art');
    assert.equal(list.currentTreeHash, EMPTY_TREE_HASH);
    assert.equal(list.dirty, false);
    assert.equal(list.versions.length, 0);
  });
});
