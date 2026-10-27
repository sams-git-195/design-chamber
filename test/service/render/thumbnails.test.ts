import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';
import { inflateSync } from 'node:zlib';

import { createFakeContext, type FakeContext } from '../../helpers/fake-context.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';
import { chromeOrSkip, isLaptopThumbSize } from '../../helpers/chrome-or-skip.ts';
import { createVersionsService } from '../../../src/service/versions.ts';
import { createRenderService } from '../../../src/service/render-cache.ts';
import { captureArgs, createThumbnailService, pngSize, thumbWorkParent, type ThumbnailServiceFull } from '../../../src/service/thumbnails.ts';
import type { BrowserResolution } from '../../../src/service/chrome.ts';
import type { ThumbnailResponse } from '../../../src/shared/api.ts';
import { artifactDesign, RED_PNG_B64, sleep } from './harness.ts';

const setup = async (t: TestContext, browser: () => BrowserResolution): Promise<{ tmp: TmpRoot; ctx: FakeContext; thumbs: ThumbnailServiceFull }> => {
  const tmp = await useTmpRoot(t);
  const ctx = createFakeContext({ root: tmp.root });
  t.after(() => ctx.dispose());
  const versions = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, quietMs: 30 });
  const renders = createRenderService({ store: ctx.store, hub: ctx.hub, onDispose: ctx.onDispose, versions });
  const thumbs = createThumbnailService({ store: ctx.store, settings: ctx.settings, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, renders, resolveBrowser: browser });
  return { tmp, ctx, thumbs };
};

/** RGB of the top-left pixel: the first pixel of row 0 is stored raw under every PNG filter. */
const firstPixel = (png: Buffer): number[] => {
  const idat: Buffer[] = [];
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  return [raw[1] ?? -1, raw[2] ?? -1, raw[3] ?? -1];
};

const pollReady = async (thumbs: ThumbnailServiceFull, slug: string, timeoutMs = 30_000): Promise<ThumbnailResponse> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await thumbs.get(slug);
    if (state.state === 'ready') return state;
    if (state.state === 'failed' || state.state === 'unavailable') throw new Error(`thumbnail ended ${state.state}: ${state.message ?? ''}`);
    if (Date.now() > deadline) throw new Error(`thumbnail not ready within ${timeoutMs} ms`);
    await sleep(250);
  }
};

describe('thumbnails without a browser', () => {
  test('get, refresh and peek all answer unavailable', async (t) => {
    const { tmp, thumbs } = await setup(t, () => ({ path: null, source: 'none' }));
    await tmp.writeDesign('art', artifactDesign());

    const got = await thumbs.get('art');
    assert.equal(got.state, 'unavailable');
    assert.equal(got.key, null);
    assert.ok(got.message && got.message.length > 0, 'a user-facing sentence explains the fallback');

    assert.deepEqual(await thumbs.refresh('art'), { state: 'unavailable' });
    assert.deepEqual(thumbs.peek('art'), { state: 'unavailable', key: null });
  });

  test('a browser that fails to launch produces failed with a message', async (t) => {
    const { tmp, thumbs } = await setup(t, () => ({ path: 'C:\\definitely-missing\\chrome-404.exe', source: 'setting' }));
    await tmp.writeDesign('art', artifactDesign());
    const first = await thumbs.get('art');
    assert.equal(first.state, 'pending');
    await sleep(1000); // the spawn error resolves fast
    const after = await thumbs.get('art');
    assert.equal(after.state, 'failed');
    assert.ok(after.message && after.message.length > 0);
    assert.equal(after.key, first.key, 'the failed state carries the render key it failed for');
    // A failed capture is not silently retried on every poll…
    assert.equal((await thumbs.get('art')).state, 'failed');
    // …but an explicit refresh retries.
    assert.deepEqual(await thumbs.refresh('art'), { state: 'pending' });
  });

  test('peek reports ready from a thumbnail already on disk', async (t) => {
    const { tmp, thumbs } = await setup(t, () => ({ path: null, source: 'none' }));
    await tmp.writeDesign('art', artifactDesign());
    await tmp.write('art/.thumb.png', Buffer.from(RED_PNG_B64, 'base64'));
    await tmp.write('art/.chamber/thumb.json', JSON.stringify({ key: 'abc123', createdAt: '2026-10-26T10:00:00.000Z', viewport: 'laptop', scheme: 'light' }));
    assert.deepEqual(thumbs.peek('art'), { state: 'ready', key: 'abc123' });
  });

  test('a thumbnail captured before the light scheme was forced (no scheme in its meta) is stale', async (t) => {
    const { tmp, thumbs } = await setup(t, () => ({ path: null, source: 'none' }));
    await tmp.writeDesign('art', artifactDesign());
    await tmp.write('art/.thumb.png', Buffer.from(RED_PNG_B64, 'base64'));
    await tmp.write('art/.chamber/thumb.json', JSON.stringify({ key: 'abc123', createdAt: '2026-10-26T10:00:00.000Z', viewport: 'laptop' }));
    assert.notEqual(thumbs.peek('art').state, 'ready');
  });

  test('captureArgs: --no-sandbox only for root on Linux; headless=new needs no display', () => {
    const input = { workDir: '/w', out: '/w/thumb.png', viewport: { id: 'laptop', label: 'Laptop', width: 1280, height: 800 }, scale: 0.25, url: 'file:///d/index.html' };
    const linuxRoot = captureArgs({ ...input, platform: 'linux', isRoot: true });
    assert.ok(linuxRoot.includes('--no-sandbox'));
    for (const [platform, isRoot] of [['linux', false], ['darwin', true], ['win32', true]] as const) {
      assert.ok(!captureArgs({ ...input, platform, isRoot }).includes('--no-sandbox'), `${platform} root=${isRoot}`);
    }
    assert.equal(linuxRoot[0], '--headless=new');
    assert.ok(linuxRoot.includes('--host-resolver-rules=MAP * ~NOTFOUND'), 'still offline');
    assert.equal(linuxRoot.at(-1), 'file:///d/index.html');
  });

  test('thumbWorkParent: the OS temp folder on win32/darwin, the design\'s .chamber/ on Linux (Snap/Flatpak private /tmp)', () => {
    assert.equal(thumbWorkParent('win32', 'C:\\D\\art', 'C:\\Temp'), 'C:\\Temp');
    assert.equal(thumbWorkParent('darwin', '/Users/you/D/art', '/var/tmp'), '/var/tmp');
    assert.equal(thumbWorkParent('linux', path.join('home', 'art'), '/tmp'), path.join('home', 'art', '.chamber'));
  });

  test('on Linux a capture works inside .chamber/, removes its folder, and clears stale ones a killed run left', async (t) => {
    const tmp = await useTmpRoot(t);
    const osTmp = await useTmpRoot(t);
    const ctx = createFakeContext({ root: tmp.root });
    t.after(() => ctx.dispose());
    const versions = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose, quietMs: 30 });
    const renders = createRenderService({ store: ctx.store, hub: ctx.hub, onDispose: ctx.onDispose, versions });
    const thumbs = createThumbnailService({
      store: ctx.store,
      settings: ctx.settings,
      hub: ctx.hub,
      log: ctx.log,
      onDispose: ctx.onDispose,
      renders,
      resolveBrowser: () => ({ path: path.join(tmp.root, 'no-such-browser'), source: 'setting' }),
      tmpdir: () => osTmp.root,
      platform: 'linux',
      isRoot: () => false,
    });
    await tmp.writeDesign('art', artifactDesign());
    const chamber = tmp.at('art/.chamber');
    await mkdir(path.join(chamber, 'dc-thumb-stale'), { recursive: true });
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(path.join(chamber, 'dc-thumb-stale'), old, old);
    await mkdir(path.join(chamber, 'dc-thumb-recent'), { recursive: true });
    await mkdir(path.join(chamber, 'keep-me'), { recursive: true });

    assert.equal((await thumbs.get('art')).state, 'pending');
    await sleep(1000);
    assert.equal((await thumbs.get('art')).state, 'failed', 'the missing browser fails the capture');
    const left = (await readdir(chamber)).sort();
    assert.ok(!left.includes('dc-thumb-stale'), 'a stale work folder is removed');
    assert.ok(left.includes('dc-thumb-recent'), 'a recent one (another run) is left alone');
    assert.ok(left.includes('keep-me'), 'nothing else in .chamber/ is touched');
    assert.equal(left.filter((name) => name.startsWith('dc-thumb-')).length, 1, 'this run cleaned up its own folder');
    assert.deepEqual(await readdir(osTmp.root), [], 'nothing was written to the OS temp folder');
  });

  test('pngSize reads the IHDR chunk', () => {
    const png = Buffer.from(RED_PNG_B64, 'base64');
    assert.deepEqual(pngSize(png), { width: 1, height: 1 });
    assert.equal(pngSize(Buffer.from('not a png at all, not a png!!', 'utf8')), null);
  });
});

describe('thumbnails with the real browser', () => {
  test('produces a 320×200 PNG, caches it on disk, and re-runs after content changes', { timeout: 90_000 }, async (t) => {
    const chrome = chromeOrSkip(t);
    if (!chrome) return;
    const { tmp, ctx, thumbs } = await setup(t, () => ({ path: chrome, source: 'detected' }));
    await tmp.writeDesign(
      'art',
      artifactDesign({
        'index.html': '<!doctype html><html><body style="margin:0;background:#223344"><h1 style="color:#fff;font:48px sans-serif">thumb me</h1></body></html>',
      }),
    );

    const first = await thumbs.get('art');
    assert.equal(first.state, 'pending', 'the first call enqueues');
    assert.ok(first.key);
    const ready = await pollReady(thumbs, 'art');
    assert.equal(ready.state, 'ready');
    assert.equal(ready.key, first.key);
    assert.ok(isLaptopThumbSize(ready), `THUMB_WIDTH scaled from the laptop viewport (1280×800 → 320×200), got ${ready.width}×${ready.height}`);
    assert.ok(ready.png && ready.png.length > 0);
    const decoded = Buffer.from(ready.png ?? '', 'base64');
    assert.deepEqual(pngSize(decoded), { width: ready.width, height: ready.height });

    // Cached on disk: .thumb.png + .chamber/thumb.json with the render key.
    assert.ok(existsSync(tmp.at('art/.thumb.png')));
    const meta = JSON.parse(readFileSync(tmp.at('art/.chamber/thumb.json'), 'utf8')) as { key: string; viewport: string };
    assert.equal(meta.key, first.key);
    assert.equal(meta.viewport, 'laptop');
    assert.deepEqual(thumbs.peek('art'), { state: 'ready', key: first.key });

    // The cached answer is immediate on the next get (same key, file on disk).
    const cached = await thumbs.get('art');
    assert.equal(cached.state, 'ready');

    // A content change (hub event) re-runs the capture with a NEW key, debounced.
    await tmp.write('art/index.html', '<!doctype html><html><body style="margin:0;background:#992211"><h1>changed</h1></body></html>');
    ctx.hub.emit({ slug: 'art', kind: 'files', files: ['index.html'] });
    const deadline = Date.now() + 30_000;
    let renewed: ThumbnailResponse | null = null;
    while (Date.now() < deadline) {
      await sleep(300);
      const state = await thumbs.get('art');
      if (state.state === 'ready' && state.key !== first.key) {
        renewed = state;
        break;
      }
    }
    assert.ok(renewed, 'the thumbnail was regenerated with a new render key');
    assert.ok(isLaptopThumbSize(renewed), `renewed ${renewed.width}×${renewed.height}`);
    const renewedMeta = JSON.parse(readFileSync(tmp.at('art/.chamber/thumb.json'), 'utf8')) as { key: string };
    assert.equal(renewedMeta.key, renewed.key);
  });

  test('captures the light colour scheme like the wall artboards, even on a dark-mode PC (KI-3)', { timeout: 60_000 }, async (t) => {
    const chrome = chromeOrSkip(t);
    if (!chrome) return;
    const { tmp, thumbs } = await setup(t, () => ({ path: chrome, source: 'detected' }));
    await tmp.writeDesign(
      'art',
      artifactDesign({
        'index.html': '<!doctype html><html><head><style>html,body{margin:0;background:rgb(255,0,0)}@media (prefers-color-scheme: dark){html,body{background:rgb(0,0,255)}}</style></head><body></body></html>',
      }),
    );
    const ready = await pollReady(thumbs, 'art');
    assert.deepEqual(firstPixel(Buffer.from(ready.png ?? '', 'base64')), [255, 0, 0], 'the light background, not the dark one');
    const meta = JSON.parse(readFileSync(tmp.at('art/.chamber/thumb.json'), 'utf8')) as { scheme: string };
    assert.equal(meta.scheme, 'light');
  });

  test('a canvas captures its first existing screen', { timeout: 60_000 }, async (t) => {
    const chrome = chromeOrSkip(t);
    if (!chrome) return;
    const { tmp, thumbs } = await setup(t, () => ({ path: chrome, source: 'detected' }));
    await tmp.writeDesign('cv', {
      'design.json': {
        version: 1,
        kind: 'canvas',
        title: 'Canvas',
        created: '2026-10-26T10:00:00.000Z',
        updated: '2026-10-26T10:00:00.000Z',
        screens: [
          { id: 'missing', title: 'Missing', file: 'screens/missing.html' },
          { id: 'home', title: 'Home', file: 'screens/home.html' },
        ],
      },
      'screens/home.html': '<!doctype html><html><body style="margin:0;background:#112233">home</body></html>',
    });
    const first = await thumbs.get('cv');
    assert.equal(first.state, 'pending');
    const ready = await pollReady(thumbs, 'cv');
    assert.ok(isLaptopThumbSize(ready), `${ready.width}×${ready.height}`);
    const meta = JSON.parse(readFileSync(tmp.at('cv/.chamber/thumb.json'), 'utf8')) as { viewport: string };
    assert.equal(meta.viewport, 'laptop');
  });

  test('a pending design (no HTML yet) is unavailable, not failed', { timeout: 30_000 }, async (t) => {
    const chrome = chromeOrSkip(t);
    if (!chrome) return;
    const { tmp, thumbs } = await setup(t, () => ({ path: chrome, source: 'detected' }));
    await tmp.writeDesign('pending', { 'design.json': { version: 1, kind: 'artifact', title: 'Pending', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z' } });
    const got = await thumbs.get('pending');
    assert.equal(got.state, 'unavailable');
    assert.ok(got.message?.includes('no HTML') || got.message?.includes('Nothing'), got.message);
    await sleep(300);
    assert.equal(thumbs.peek('pending').state, 'unavailable');
  });
});
