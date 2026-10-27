import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createFakeContext, type FakeContext } from '../../helpers/fake-context.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';
import { createExportService, type ExportService } from '../../../src/service/export.ts';
import { ApiError } from '../../../src/service/http.ts';
import { artifactDesign, canvasDesign, redPng } from './harness.ts';
import { readZip } from './zip-reader.ts';

const setup = async (t: TestContext): Promise<{ tmp: TmpRoot; downloads: string; ctx: FakeContext; exports: ExportService; issued: string[] }> => {
  const tmp = await useTmpRoot(t);
  const downloadsTmp = await useTmpRoot(t);
  const ctx = createFakeContext({ root: tmp.root, settings: { downloadsDir: downloadsTmp.root } });
  t.after(() => ctx.dispose());
  const issued: string[] = [];
  const exports = createExportService({ store: ctx.store, settings: ctx.settings, log: ctx.log, issue: (p) => issued.push(p) });
  return { tmp, downloads: downloadsTmp.root, ctx, exports, issued };
};

describe('export service', () => {
  test('ZIP keeps the folder tree, excludes design.json/.chamber/.versions/.thumb.png', async (t) => {
    const { tmp, downloads, exports, issued } = await setup(t);
    await tmp.writeDesign(
      'cv',
      canvasDesign({
        'assets/pic.png': redPng(),
        'assets/deep/nested/data.json': { a: 1 },
        'DESIGN.md': '# design system',
        'tokens.css': ':root{--x:1}',
        '.chamber/state.json': '{}',
        '.versions/index.json': '{}',
        '.thumb.png': 'nope',
      }),
    );
    const result = await exports.export('cv', { format: 'zip' });
    assert.equal(result.format, 'zip');
    assert.equal(result.path, path.join(downloads, 'cv.zip'));
    assert.equal(result.bytes, (await readFile(result.path)).length);

    const zip = readZip(await readFile(result.path));
    assert.deepEqual(
      zip.map((entry) => entry.name).sort(),
      ['cv/DESIGN.md', 'cv/assets/deep/nested/data.json', 'cv/assets/pic.png', 'cv/screens/checkout.html', 'cv/screens/home.html', 'cv/tokens.css'],
    );
    const png = zip.find((entry) => entry.name === 'cv/assets/pic.png');
    assert.ok(png?.data.equals(Buffer.from(redPng())), 'binary content survives the round trip');
    assert.deepEqual(issued, [result.path], 'the path is issued for /reveal');
  });

  test('collisions get " (2)", " (3)"… names', async (t) => {
    const { tmp, downloads, exports } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    const first = await exports.export('art', { format: 'zip' });
    const second = await exports.export('art', { format: 'zip' });
    const third = await exports.export('art', { format: 'zip' });
    assert.equal(path.basename(first.path), 'art.zip');
    assert.equal(path.basename(second.path), 'art (2).zip');
    assert.equal(path.basename(third.path), 'art (3).zip');
    assert.equal(path.dirname(third.path), downloads);
  });

  test('single-file HTML inlines assets and names canvas exports after the screen', async (t) => {
    const { tmp, exports, issued } = await setup(t);
    await tmp.writeDesign('cv', canvasDesign({ 'assets/pic.png': redPng() }));
    await tmp.write('cv/screens/home.html', '<!doctype html><html><body><img src="../assets/pic.png"><img src="../assets/gone.png"></body></html>');
    const result = await exports.export('cv', { format: 'html', screen: 'home' });
    assert.equal(path.basename(result.path), 'cv-home.html');
    const html = await readFile(result.path, 'utf8');
    assert.ok(html.includes('data:image/png;base64,'), 'the asset is inlined');
    assert.ok(!html.includes('../assets/pic.png'), 'no relative refs to inlined assets survive');
    assert.ok(html.includes('../assets/gone.png'), 'a missing ref stays visible (fails closed)');
    assert.deepEqual(issued, [result.path]);
  });

  test('a design with nothing to export is refused with no-html, an unknown format with bad-request', async (t) => {
    const { tmp, exports } = await setup(t);
    // Only design.json exists → the tracked-minus-design.json set is empty.
    await tmp.write('bare/design.json', { version: 1, kind: 'artifact', title: 'B', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z' });
    await assert.rejects(exports.export('bare', { format: 'zip' }), (error: unknown) => error instanceof ApiError && error.code === 'no-html');
    await assert.rejects(exports.export('bare', { format: 'html' }), (error: unknown) => error instanceof ApiError && error.code === 'no-html');
    await tmp.writeDesign('art', artifactDesign());
    await assert.rejects(
      exports.export('art', { format: 'pdf' as unknown as 'zip' }),
      (error: unknown) => error instanceof ApiError && error.code === 'bad-request',
    );
    await assert.rejects(exports.export('nope', { format: 'zip' }), (error: unknown) => error instanceof ApiError && error.code === 'not-found');
    await assert.rejects(exports.export('Bad Slug', { format: 'zip' }), (error: unknown) => error instanceof ApiError && error.code === 'bad-slug');
  });

  test('no temporary files are left behind in the destination folder', async (t) => {
    const { tmp, downloads, exports } = await setup(t);
    await tmp.writeDesign('art', artifactDesign());
    await exports.export('art', { format: 'zip' });
    const left = await readdir(downloads);
    assert.deepEqual(left, ['art.zip']);
  });
});
