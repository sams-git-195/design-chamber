import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { describe, test, type TestContext } from 'node:test';

import { extractTitle, resolveEntryFile, splitChunks } from '../../../src/service/render-cache.ts';
import { createRenderService } from '../../../src/service/render-cache.ts';
import { createVersionsService } from '../../../src/service/versions.ts';
import type { RenderService } from '../../../src/service/context.ts';
import { createFakeContext, type FakeContext } from '../../helpers/fake-context.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';
import { ApiError } from '../../../src/service/http.ts';
import { artifactDesign, canvasDesign, sleep } from './harness.ts';

const collect = async (renders: RenderService, slug: string, query: { screen?: string; version?: string } = {}) => {
  const meta = await renders.render(slug, query);
  let doc = '';
  for (let n = 0; n < meta.chunks; n += 1) doc += renders.chunk(meta.key, n);
  return { meta, doc };
};

const setup = async (t: TestContext): Promise<{ tmp: TmpRoot; ctx: FakeContext; renders: ReturnType<typeof createRenderService>; versions: ReturnType<typeof createVersionsService> }> => {
  const tmp = await useTmpRoot(t);
  const ctx = createFakeContext({ root: tmp.root });
  t.after(() => ctx.dispose());
  const versions = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, quietMs: 30 });
  const renders = createRenderService({ store: ctx.store, hub: ctx.hub, onDispose: ctx.onDispose, versions });
  return { tmp, ctx, renders, versions };
};

describe('splitChunks', () => {
  const hasLoneSurrogate = (text: string): boolean => {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = text.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        return true;
      }
    }
    return false;
  };

  test('reassembles byte-exact at awkward chunk sizes with multi-byte text and surrogate pairs', () => {
    const doc = `<!doctype html><p>${'日本語'.repeat(500)}${'🎨'.repeat(500)}</p>${'x'.repeat(3000)}`;
    for (const maxBytes of [7, 64, 999, 4096]) {
      const chunks = splitChunks(doc, maxBytes);
      for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(chunk, 'utf8') <= maxBytes, `chunk respects the ${maxBytes}-byte cap`);
        assert.ok(!hasLoneSurrogate(chunk), 'no chunk carries a lone surrogate');
      }
      assert.equal(chunks.join(''), doc, 'reassembly is exact');
      assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk, 'utf8'))).toString('utf8'), doc, 'byte-level reassembly is exact');
    }
  });

  test('an empty document has no chunks; a small one has exactly one', () => {
    assert.deepEqual(splitChunks(''), []);
    assert.deepEqual(splitChunks('hello', 100), ['hello']);
  });
});

describe('extractTitle', () => {
  test('decodes basic entities, strips nested tags, caps the length', () => {
    assert.equal(extractTitle('<html><head><title>Hello &amp; welcome</title></head></html>'), 'Hello & welcome');
    assert.equal(extractTitle('<TITLE>  Spaced\n\tout  </TITLE>'), 'Spaced out');
    assert.equal(extractTitle('<title>a'.repeat(1)), '');
    assert.equal(extractTitle('<p>no title here</p>'), '');
    assert.equal(extractTitle(`<title>${'t'.repeat(500)}</title>`).length, 200);
  });
});

describe('resolveEntryFile', () => {
  test('artifacts render index.html and refuse a screen', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createFakeContext({ root: tmp.root });
    t.after(() => ctx.dispose());
    await tmp.writeDesign('art', artifactDesign());
    const record = await ctx.store.get('art');
    assert.deepEqual(resolveEntryFile(record.design, record.files, undefined), { entryRel: 'index.html', screenId: null });
    assert.throws(() => resolveEntryFile(record.design, record.files, 'home'), ApiError);
  });

  test('canvases default to the first screen with a file and 404 on unknown screens', async (t) => {
    const tmp = await useTmpRoot(t);
    const ctx = createFakeContext({ root: tmp.root });
    t.after(() => ctx.dispose());
    await tmp.writeDesign('cv', canvasDesign());
    const record = await ctx.store.get('cv');
    assert.deepEqual(resolveEntryFile(record.design, record.files, undefined), { entryRel: 'screens/home.html', screenId: 'home' });
    assert.deepEqual(resolveEntryFile(record.design, record.files, 'checkout'), { entryRel: 'screens/checkout.html', screenId: 'checkout' });
    assert.throws(() => resolveEntryFile(record.design, record.files, 'nope'), (error: unknown) => error instanceof ApiError && error.code === 'not-found');
    assert.throws(() => resolveEntryFile(record.design, record.files, '../evil'), (error: unknown) => error instanceof ApiError && error.code === 'bad-request');
    // home.html missing → the default falls through to checkout
    await rm(tmp.at('cv/screens/home.html'));
    const after = await ctx.store.get('cv');
    assert.deepEqual(resolveEntryFile(after.design, after.files, undefined), { entryRel: 'screens/checkout.html', screenId: 'checkout' });
  });
});

describe('render service', () => {
  test('bundles, keys and serves chunks; the key changes when a file changes', async (t) => {
    const { tmp, ctx, renders } = await setup(t);
    await tmp.writeDesign('art', artifactDesign({ 'assets/pic.png': 'not really a png' }));
    await tmp.write(
      'art/index.html',
      '<!doctype html><html><head><title>Art</title></head><body><img src="assets/pic.png"><p>v1</p></body></html>',
    );

    const first = await collect(renders, 'art');
    assert.ok(first.doc.includes('<p>v1</p>'));
    assert.ok(first.doc.includes('data:image/png;base64,'), 'the asset is inlined as a data URL (mime from the extension)');
    assert.equal(first.meta.title, 'Art');
    assert.equal(first.meta.chunks, 1);
    assert.equal(first.doc.length > 0, true);

    // Unchanged → identical key (cache hit path).
    const again = await collect(renders, 'art');
    assert.equal(again.meta.key, first.meta.key);

    // Changed + hub event → new key; the old key is stale (evicted).
    await tmp.write('art/index.html', '<!doctype html><p>v2</p>');
    ctx.hub.emit({ slug: 'art', kind: 'files', files: ['index.html'] });
    const second = await collect(renders, 'art');
    assert.notEqual(second.meta.key, first.meta.key);
    assert.ok(second.doc.includes('<p>v2</p>'));
    assert.throws(() => renders.chunk(first.meta.key, 0), (error: unknown) => error instanceof ApiError && error.code === 'stale');
  });

  test('an asset-only change also changes the key (inputs include assets)', async (t) => {
    const { tmp, ctx, renders } = await setup(t);
    await tmp.writeDesign('art', artifactDesign({ 'assets/data.css': 'body{color:red}' }));
    await tmp.write('art/index.html', '<!doctype html><link rel="stylesheet" href="assets/data.css"><p>x</p>');
    const first = await collect(renders, 'art');
    await sleep(20); // mtime granularity guard
    await tmp.write('art/assets/data.css', 'body{color:blue}');
    ctx.hub.emit({ slug: 'art', kind: 'files', files: ['assets/data.css'] });
    const second = await collect(renders, 'art');
    assert.notEqual(second.meta.key, first.meta.key);
    assert.ok(second.doc.includes('color:blue'));
  });

  test('a missing entry is 422 no-html; an unknown slug is 404; a bad slug is 400', async (t) => {
    const { tmp, renders } = await setup(t);
    await tmp.writeDesign('empty', { 'design.json': { version: 1, kind: 'artifact', title: 'E', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z' } });
    await assert.rejects(renders.render('empty', {}), (error: unknown) => error instanceof ApiError && error.code === 'no-html');
    await assert.rejects(renders.render('nope', {}), (error: unknown) => error instanceof ApiError && error.code === 'not-found');
    await assert.rejects(renders.render('Bad Slug', {}), (error: unknown) => error instanceof ApiError && error.code === 'bad-slug');
  });

  test('version renders show the snapshot even after the live files change', async (t) => {
    const { tmp, renders, versions } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    await tmp.write('art/index.html', '<!doctype html><p>old text</p>');
    const v1 = await versions.create('art', 'manual');
    assert.ok(v1);
    await tmp.write('art/index.html', '<!doctype html><p>new text</p>');

    const live = await collect(renders, 'art');
    assert.ok(live.doc.includes('new text'));
    const frozen = await collect(renders, 'art', { version: 'v1' });
    assert.ok(frozen.doc.includes('old text'), 'the version renders the snapshot content');
    assert.notEqual(frozen.meta.key, live.meta.key);
    // Immutable: a second version render hits the cache with the same key.
    const frozen2 = await collect(renders, 'art', { version: 'v1' });
    assert.equal(frozen2.meta.key, frozen.meta.key);
    await assert.rejects(renders.render('art', { version: 'v77' }), (error: unknown) => error instanceof ApiError && error.code === 'not-found');
    await assert.rejects(renders.render('art', { version: 'nonsense' }), (error: unknown) => error instanceof ApiError && error.code === 'bad-request');
  });

  test('chunk refuses out-of-range numbers and malformed keys', async (t) => {
    const { tmp, renders } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    const meta = await renders.render('art', {});
    assert.equal(typeof renders.chunk(meta.key, 0), 'string');
    assert.throws(() => renders.chunk(meta.key, 1), (error: unknown) => error instanceof ApiError && error.code === 'bad-request');
    assert.throws(() => renders.chunk(meta.key, -1), (error: unknown) => error instanceof ApiError && error.code === 'bad-request');
    assert.throws(() => renders.chunk('not-a-key', 0), (error: unknown) => error instanceof ApiError && error.code === 'stale');
  });
});
