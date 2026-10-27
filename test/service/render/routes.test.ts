// HTTP-level tests for the WP2 routes: bearer, validation, chunked render reassembly of a
// >6 MB document, versions/diff/restore, export + reveal over the wire (§15.2 shape).

import assert from 'node:assert/strict';
import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import type {
  ExportResponse,
  RenderMeta,
  RestoreVersionResponse,
  SourceResponse,
  TurnSnapshotResponse,
  VersionDiffResponse,
  VersionListResponse,
  CreateVersionResponse,
} from '../../../src/shared/api.ts';
import { RENDER_CHUNK_MAX_BYTES } from '../../../src/shared/limits.ts';
import { BRIDGE_PLACEHOLDER } from '../../../src/shared/bridge-protocol.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { artifactDesign, canvasDesign, startWp2, type Wp2Service } from './harness.ts';
import { readZip } from './zip-reader.ts';

const chunksOf = async (svc: Wp2Service, slug: string, meta: RenderMeta): Promise<string> => {
  let doc = '';
  for (let n = 0; n < meta.chunks; n += 1) {
    const answer = await svc.call(`/designs/${slug}/render/chunk`, { query: { key: meta.key, n: String(n) } });
    assert.equal(answer.status, 200);
    assert.match(answer.headers.get('content-type') ?? '', /^text\/plain/, 'chunks are raw text');
    doc += await answer.text();
  }
  return doc;
};

describe('WP2 routes over HTTP', () => {
  test('every WP2 route refuses a missing or wrong token with 401', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('art', artifactDesign());
    const svc = await startWp2(t, { root: tmp.root });
    const probes: [string, { method?: string; body?: unknown }][] = [
      ['/designs/art/render', {}],
      ['/designs/art/render/chunk?key=00&n=0', {}],
      ['/designs/art/source', {}],
      ['/designs/art/versions', {}],
      ['/designs/art/versions', { method: 'POST', body: { reason: 'manual' } }],
      ['/versions/turn', { method: 'POST', body: { sessionId: 'ses_x' } }],
      ['/designs/art/versions/v1/diff', {}],
      ['/designs/art/versions/v1/restore', { method: 'POST' }],
      ['/designs/art/export', { method: 'POST', body: { format: 'zip' } }],
      ['/reveal', { method: 'POST', body: { path: 'C:\\x' } }],
      ['/designs/art/thumbnail', {}],
      ['/designs/art/thumbnail/refresh', { method: 'POST' }],
    ];
    for (const [pathname, init] of probes) {
      for (const token of [null, 'wrong'] as const) {
        const answer = await svc.call(pathname, { ...init, token });
        assert.equal(answer.status, 401, `${pathname} token=${token}`);
        assert.equal((await answer.json() as { error: string }).error, 'unauthorized');
      }
    }
  });

  test('render + chunk round-trip a document byte-exact, with the bridge placeholder', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('art', artifactDesign());
    const svc = await startWp2(t, { root: tmp.root });
    const meta = await svc.json<RenderMeta>('/designs/art/render');
    assert.ok(meta.key.match(/^[0-9a-f]{64}$/));
    assert.equal(meta.title, 'Artifact');
    const doc = await chunksOf(svc, 'art', meta);
    assert.equal(Buffer.byteLength(doc, 'utf8'), meta.bytes);
    assert.ok(doc.includes(`<head>${BRIDGE_PLACEHOLDER}`), 'render mode injects the placeholder');
    assert.ok(doc.includes('<h1>hello</h1>'));
  });

  test('a >6 MB document is chunked and reassembles byte-exact (multi-byte payload)', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('big', artifactDesign());
    // 1.8 M emoji × 4 UTF-8 bytes ≈ 7.2 MB — the chunk boundary lands inside the emoji run,
    // so a splitter that breaks surrogate pairs would corrupt the reassembly.
    const payload = '🎨'.repeat(1_800_000);
    await tmp.write('big/index.html', `<!doctype html><html><head><title>Big</title></head><body><p>${payload}</p></body></html>`);
    const svc = await startWp2(t, { root: tmp.root });

    const meta = await svc.json<RenderMeta>('/designs/big/render');
    assert.ok(meta.bytes > RENDER_CHUNK_MAX_BYTES, 'the document really is over one chunk');
    assert.ok(meta.chunks >= 2, 'it is served in several chunks');

    let doc = '';
    for (let n = 0; n < meta.chunks; n += 1) {
      const answer = await svc.call('/designs/big/render/chunk', { query: { key: meta.key, n: String(n) } });
      assert.equal(answer.status, 200);
      const text = await answer.text();
      assert.ok(Buffer.byteLength(text, 'utf8') <= RENDER_CHUNK_MAX_BYTES, `chunk ${n} respects the cap`);
      doc += text;
    }
    assert.equal(Buffer.byteLength(doc, 'utf8'), meta.bytes, 'byte-exact reassembly');
    assert.equal(doc.match(/🎨/g)?.length, 1_800_000, 'every emoji survived the chunk boundaries');
    assert.ok(doc.includes('</body></html>'));
  });

  test('chunk validation: malformed key 400, malformed n 400, evicted key 409 stale', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('art', artifactDesign());
    const svc = await startWp2(t, { root: tmp.root });
    const meta = await svc.json<RenderMeta>('/designs/art/render');

    const badKey = await svc.call('/designs/art/render/chunk', { query: { key: 'nope', n: '0' } });
    assert.equal(badKey.status, 400);
    const badN = await svc.call('/designs/art/render/chunk', { query: { key: meta.key, n: 'x' } });
    assert.equal(badN.status, 400);
    const outOfRange = await svc.call('/designs/art/render/chunk', { query: { key: meta.key, n: '99' } });
    assert.equal(outOfRange.status, 400);

    // A content change evicts the entry → the old key is stale.
    await tmp.write('art/index.html', '<!doctype html><p>changed</p>');
    svc.ctx.hub.emit({ slug: 'art', kind: 'files', files: ['index.html'] });
    const stale = await svc.call('/designs/art/render/chunk', { query: { key: meta.key, n: '0' } });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: string }).error, 'stale');
  });

  test('render validation: unknown screen 404, unknown version 404, bad ids 400, missing entry 422', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('cv', canvasDesign());
    await tmp.writeDesign('noentry', {
      'design.json': { version: 1, kind: 'artifact', title: 'No entry', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z' },
    });
    const svc = await startWp2(t, { root: tmp.root });

    assert.equal((await svc.call('/designs/cv/render', { query: { screen: 'nope' } })).status, 404);
    assert.equal((await svc.call('/designs/cv/render', { query: { screen: 'BAD' } })).status, 400);
    assert.equal((await svc.call('/designs/cv/render', { query: { version: 'v77' } })).status, 404);
    assert.equal((await svc.call('/designs/cv/render', { query: { version: 'junk' } })).status, 400);
    assert.equal((await svc.call('/designs/noentry/render')).status, 422);
    assert.equal((await svc.call('/designs/missing-design/render')).status, 404);
    assert.equal((await svc.call('/designs/Bad%20Slug/render')).status, 400);

    // Canvas default screen + explicit screen.
    const home = await svc.json<RenderMeta>('/designs/cv/render');
    assert.equal(home.title, 'Home');
    const checkout = await svc.json<RenderMeta>('/designs/cv/render', { query: { screen: 'checkout' } });
    assert.equal(checkout.title, 'Checkout');
  });

  test('source answers the raw entry text and its byte size', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('cv', canvasDesign());
    const svc = await startWp2(t, { root: tmp.root });
    const home = await svc.json<SourceResponse>('/designs/cv/source');
    assert.equal(home.text, await tmp.read('cv/screens/home.html'));
    assert.equal(home.bytes, Buffer.byteLength(home.text, 'utf8'));
    const checkout = await svc.json<SourceResponse>('/designs/cv/source', { query: { screen: 'checkout' } });
    assert.ok(checkout.text.includes('checkout'));
    assert.equal((await svc.call('/designs/cv/source', { query: { screen: 'nope' } })).status, 404);
  });

  test('source never follows a screens junction out of the design', async (t) => {
    const tmp = await useTmpRoot(t);
    const outside = await useTmpRoot(t);
    await tmp.writeDesign('cv', canvasDesign());
    await outside.write('screens/home.html', '<p>outside secret</p>');
    await rm(tmp.at('cv/screens'), { recursive: true });
    await symlink(outside.at('screens'), tmp.at('cv/screens'), 'junction');
    const svc = await startWp2(t, { root: tmp.root });
    const answer = await svc.call('/designs/cv/source', { query: { screen: 'home' } });
    assert.equal(answer.status, 422);
    assert.equal(((await answer.json()) as { error: string }).error, 'no-html');
  });

  test('versions over HTTP: create, list, turn, diff, restore', async (t) => {
    const tmp = await useTmpRoot(t);
    const downloads = await useTmpRoot(t);
    await tmp.writeDesign(
      'art',
      artifactDesign({
        'design.json': { version: 1, kind: 'artifact', title: 'Test artifact', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z', sessionId: 'ses_http' },
      }),
    );
    const svc = await startWp2(t, { root: tmp.root, settings: { downloadsDir: downloads.root } });

    const created = await svc.json<CreateVersionResponse>('/designs/art/versions', { method: 'POST', body: { reason: 'manual' } });
    assert.equal(created.created?.id, 'v1');
    const dup = await svc.json<CreateVersionResponse>('/designs/art/versions', { method: 'POST', body: { reason: 'manual' } });
    assert.equal(dup.created, null);
    assert.equal((await svc.call('/designs/art/versions', { method: 'POST', body: { reason: 'nope' } })).status, 400);

    const list = await svc.json<VersionListResponse>('/designs/art/versions');
    assert.equal(list.versions.length, 1);
    assert.equal(list.dirty, false);
    assert.ok(!('files' in (list.versions[0] as object)), 'the wire summary carries no file map');
    assert.equal(list.versions[0]?.fileCount, 2);

    await tmp.write('art/index.html', '<p>turn changed it</p>');
    const turn = await svc.json<TurnSnapshotResponse>('/versions/turn', { method: 'POST', body: { sessionId: 'ses_http' } });
    assert.deepEqual(turn.created, [{ slug: 'art', id: 'v2' }]);
    await tmp.write('art/index.html', '<p>changed again inside the window</p>');
    const turnAgain = await svc.json<TurnSnapshotResponse>('/versions/turn', { method: 'POST', body: { sessionId: 'ses_http' } });
    assert.deepEqual(turnAgain.created, turn.created, 'the 2 s window collapses repeated turn calls into the first run');
    assert.equal((await svc.json<VersionListResponse>('/designs/art/versions')).versions.length, 2, 'no third version inside the window');
    assert.equal((await svc.call('/versions/turn', { method: 'POST', body: {} })).status, 400);

    const diff = await svc.json<VersionDiffResponse>('/designs/art/versions/v1/diff');
    assert.deepEqual(diff.files, [{ path: 'index.html', change: 'modified' }]);
    const diffV1V2 = await svc.json<VersionDiffResponse>('/designs/art/versions/v1/diff', { query: { against: 'v2' } });
    assert.deepEqual(diffV1V2.files, [{ path: 'index.html', change: 'modified' }]);
    assert.equal((await svc.call('/designs/art/versions/junk/diff')).status, 400);
    assert.equal((await svc.call('/designs/art/versions/v1/diff', { query: { against: 'junk' } })).status, 400);

    await tmp.write('art/index.html', '<p>dirty edit</p>');
    const restored = await svc.json<RestoreVersionResponse>('/designs/art/versions/v1/restore', { method: 'POST' });
    assert.equal(restored.restorePoint?.reason, 'restore-point');
    assert.equal(restored.restored.reason, 'restored');
    assert.ok((await tmp.read('art/index.html')).includes('<h1>hello</h1>'));
    assert.equal((await svc.call('/designs/art/versions/v99/restore', { method: 'POST' })).status, 404);
  });

  test('export ZIP over HTTP: tracked files under <slug>/, no design.json; reveal accepts it', async (t) => {
    const tmp = await useTmpRoot(t);
    const downloads = await useTmpRoot(t);
    await tmp.writeDesign('art', artifactDesign({ 'assets/pic.png': 'png-bytes', 'DESIGN.md': '# design' }));
    await tmp.write('art/.chamber/state.json', '{}');
    await tmp.write('art/.thumb.png', 'nope');
    const svc = await startWp2(t, { root: tmp.root, settings: { downloadsDir: downloads.root } });

    const exported = await svc.json<ExportResponse>('/designs/art/export', { method: 'POST', body: { format: 'zip' } });
    assert.equal(exported.format, 'zip');
    assert.equal(path.basename(exported.path), 'art.zip');
    assert.equal(path.dirname(exported.path), downloads.root, 'written to the configured downloads dir');
    const zip = readZip(await readFile(exported.path));
    assert.deepEqual(
      zip.map((entry) => entry.name).sort(),
      ['art/DESIGN.md', 'art/assets/pic.png', 'art/index.html'],
      'design.json, .chamber and .thumb.png are never exported',
    );
    assert.equal(exported.bytes, (await readFile(exported.path)).length);

    // A second export gets a collision-safe name.
    const second = await svc.json<ExportResponse>('/designs/art/export', { method: 'POST', body: { format: 'zip' } });
    assert.equal(path.basename(second.path), 'art (2).zip');

    // Reveal refusals over the wire (the ACCEPT path spawns a real Explorer window, so it is
    // unit-tested with an injected spawn in reveal.test.ts instead of fired from here).
    const foreign = await svc.call('/reveal', { method: 'POST', body: { path: tmp.at('art/index.html') } });
    assert.equal(foreign.status, 400);
    assert.equal(((await foreign.json()) as { error: string }).error, 'bad-path');
    const foreignFolder = await svc.call('/reveal', { method: 'POST', body: { path: downloads.root } });
    assert.equal(foreignFolder.status, 400, 'a folder that is neither an issued export nor a design is refused');
    assert.equal((await svc.call('/reveal', { method: 'POST', body: {} })).status, 400);
    assert.equal((await svc.call('/designs/art/export', { method: 'POST', body: { format: 'pdf' } })).status, 400);
  });

  test('export single-file HTML over HTTP: no relative refs, no placeholder, screen selection', async (t) => {
    const tmp = await useTmpRoot(t);
    const downloads = await useTmpRoot(t);
    await tmp.writeDesign('cv', canvasDesign({ 'assets/pic.png': Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64') }));
    await tmp.write('cv/screens/home.html', '<!doctype html><html><head><title>Home</title></head><body><img src="../assets/pic.png"><link rel="stylesheet" href="../assets/theme.css"></body></html>');
    await tmp.write('cv/assets/theme.css', 'body{background:url(pic.png)}');
    const svc = await startWp2(t, { root: tmp.root, settings: { downloadsDir: downloads.root } });

    const home = await svc.json<ExportResponse>('/designs/cv/export', { method: 'POST', body: { format: 'html' } });
    assert.equal(path.basename(home.path), 'cv-home.html', 'the default canvas screen names the file');
    const html = await readFile(home.path, 'utf8');
    assert.ok(!html.includes(BRIDGE_PLACEHOLDER), 'export carries no bridge placeholder');
    assert.ok(!/src="\.\.?\//.test(html) && !/href="\.\.?\//.test(html) && !/url\(\.\.?\//.test(html), 'no relative refs survive');
    assert.ok(html.includes('data:image/png;base64,'));

    const checkout = await svc.json<ExportResponse>('/designs/cv/export', { method: 'POST', body: { format: 'html', screen: 'checkout' } });
    assert.equal(path.basename(checkout.path), 'cv-checkout.html');
    assert.equal((await svc.call('/designs/cv/export', { method: 'POST', body: { format: 'html', screen: 'nope' } })).status, 404);
  });

  test('export falls back to <root>/.exports when the downloads dir cannot be created', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('art', artifactDesign());
    // A FILE where the downloads dir should be → mkdir fails → fallback.
    const blocker = path.join(tmp.root, 'blocker');
    await writeFile(blocker, 'x');
    const svc = await startWp2(t, { root: tmp.root, settings: { downloadsDir: path.join(blocker, 'downloads') } });
    const exported = await svc.json<ExportResponse>('/designs/art/export', { method: 'POST', body: { format: 'zip' } });
    assert.equal(exported.path, path.join(tmp.root, '.exports', 'art.zip'));
  });

  test('thumbnail routes answer through a branded ctx.thumbnails service', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.writeDesign('art', artifactDesign());
    // A branded fake proves the routes reuse an already-wired instance (the integration shape)
    // instead of creating a second one.
    const calls: string[] = [];
    const fakeThumbs = {
      __dcThumbnailService: true as const,
      peek: () => ({ state: 'ready' as const, key: 'k' }),
      get: async () => {
        calls.push('get');
        return { state: 'ready' as const, key: 'k', png: 'AAAA', width: 320, height: 200 };
      },
      refresh: async () => {
        calls.push('refresh');
        return { state: 'pending' as const };
      },
    };
    const svc = await startWp2(t, { root: tmp.root, overrides: { thumbnails: fakeThumbs } });
    const got = await svc.json<{ state: string; png?: string }>('/designs/art/thumbnail');
    assert.equal(got.state, 'ready');
    assert.equal(got.png, 'AAAA');
    const refreshed = await svc.json<{ state: string }>('/designs/art/thumbnail/refresh', { method: 'POST' });
    assert.equal(refreshed.state, 'pending');
    assert.deepEqual(calls, ['get', 'refresh']);
  });
});
