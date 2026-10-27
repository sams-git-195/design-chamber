// End to end through the BUILT service (docs/SPEC.md §15.2): dist/service/main.js started the
// way the host starts it (port + bearer in the env, tmp settings file and designs root), then
// one design's whole life over HTTP — create a canvas, the "agent" writes a screen and assets,
// the watcher reports it, render inlines everything and leaves the bridge placeholder,
// a version is snapshotted, ZIP and single-file HTML land in the downloads folder, a thumbnail
// is captured (skipped without Chrome/Edge), and /chip writes RULES.md.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import type {
  ChangesResponse,
  ChipResponse,
  CreateDesignResponse,
  CreateVersionResponse,
  ExportResponse,
  RenderMeta,
  SettingsResponse,
  ThumbnailResponse,
  VersionListResponse,
} from '../../../src/shared/api.ts';
import { BRIDGE_PLACEHOLDER } from '../../../src/shared/bridge-protocol.ts';
import type { ChangeEvent } from '../../../src/shared/types.ts';
import { findTestBrowser, isLaptopThumbSize } from '../../helpers/chrome-or-skip.ts';
import { BUILT_MAIN, useServiceProcess, type RunningService, type ServiceRequest } from '../../helpers/service-process.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { readZip } from '../render/zip-reader.ts';

const LOGO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#c0392b"/></svg>';
const SITE_CSS = 'body { margin: 0; font-family: serif; } .logo { background: url(logo.svg) no-repeat; }';
const HOME_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Coffee shop — Home</title><link rel="stylesheet" href="../assets/site.css"></head>
<body><img class="logo" src="../assets/logo.svg" alt="Logo"><h1>Fresh roasts every Monday</h1></body>
</html>
`;

const callJson = async <T>(service: RunningService, pathname: string, init?: ServiceRequest): Promise<T> => {
  const answer = await service.request(pathname, init);
  const text = await answer.text();
  assert.ok(answer.ok, `${init?.method ?? 'GET'} ${pathname} → ${answer.status}: ${text}`);
  return JSON.parse(text) as T;
};

test('the built service runs a canvas design end to end', { timeout: 120_000 }, async (t) => {
  if (!existsSync(BUILT_MAIN)) {
    t.skip('dist/service/main.js is missing — run `npm run build` (npm run check does) to test the built service.');
    return;
  }
  const tmp = await useTmpRoot(t, 'dc-e2e-');
  const root = tmp.at('designs');
  const downloads = tmp.at('downloads');
  await mkdir(root, { recursive: true });
  await mkdir(downloads, { recursive: true });
  const browser = findTestBrowser();
  const settingsPath = await tmp.write('settings.json', { version: 1, root, downloadsDir: downloads, ...(browser ? { chromePath: browser } : {}) });

  const service = await useServiceProcess(t, { DC_SETTINGS_PATH: settingsPath }, BUILT_MAIN);
  assert.equal((await service.request('/designs', { token: null })).status, 401);

  const settings = await callJson<SettingsResponse>(service, '/settings');
  assert.equal(settings.root, root);
  assert.equal(settings.downloadsDir, downloads);

  // The change feed: the first call resets, later ones long-poll from the cursor.
  const first = await callJson<ChangesResponse>(service, '/changes', { query: { since: '0', epoch: '' } });
  assert.equal(first.reset, true);
  const { epoch } = first;
  let cursor = first.seq;
  const seen: ChangeEvent[] = [];
  const waitForEvent = async (label: string, match: (event: ChangeEvent) => boolean): Promise<void> => {
    const deadline = Date.now() + 20_000;
    while (!seen.some(match)) {
      assert.ok(Date.now() < deadline, `no ${label} event within 20 s; saw ${JSON.stringify(seen)}\nservice log:\n${service.output().slice(-4000)}`);
      const page = await callJson<ChangesResponse>(service, '/changes', { query: { since: String(cursor), epoch, wait: '3000' } });
      assert.equal(page.reset, false);
      seen.push(...page.events);
      cursor = page.seq;
    }
  };

  // 1. Create a canvas design.
  const created = await callJson<CreateDesignResponse>(service, '/designs', { method: 'POST', body: { kind: 'canvas', title: 'Coffee shop' } });
  assert.equal(created.slug, 'coffee-shop');
  assert.equal(created.path, path.join(root, 'coffee-shop'));
  await access(path.join(created.path, '.chamber', 'RULES.md'));
  await waitForEvent('added', (event) => event.slug === created.slug && event.kind === 'added');
  // Let the watcher take its baseline of the new folder first: writes inside its 250 ms
  // debounce are folded into its own `added` for the slug instead of a `files` event.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // 2. The "agent" writes a screen, its assets and the screens list (keeping every other key).
  await tmp.write('designs/coffee-shop/assets/logo.svg', LOGO_SVG);
  await tmp.write('designs/coffee-shop/assets/site.css', SITE_CSS);
  await tmp.write('designs/coffee-shop/screens/home.html', HOME_HTML);
  const designFile = path.join(created.path, 'design.json');
  const design = JSON.parse(await readFile(designFile, 'utf8')) as Record<string, unknown>;
  design.screens = [{ id: 'home', title: 'Home', file: 'screens/home.html' }];
  design.viewports = [{ id: 'laptop', label: 'Laptop', width: 1280, height: 800 }];
  design.updated = new Date().toISOString();
  await writeFile(designFile, `${JSON.stringify(design, null, 2)}\n`, 'utf8');
  await waitForEvent('files', (event) => event.slug === created.slug && event.kind === 'files' && (event.files ?? []).includes('screens/home.html'));

  // 3. Render: one self-contained document with the bridge placeholder first in <head>.
  const meta = await callJson<RenderMeta>(service, `/designs/${created.slug}/render`, { query: { screen: 'home' } });
  assert.equal(meta.title, 'Coffee shop — Home');
  assert.deepEqual([meta.missing, meta.blocked, meta.external], [[], [], []]);
  let doc = '';
  for (let n = 0; n < meta.chunks; n += 1) {
    const chunk = await service.request(`/designs/${created.slug}/render/chunk`, { query: { key: meta.key, n: String(n) } });
    assert.equal(chunk.status, 200);
    doc += await chunk.text();
  }
  assert.equal(Buffer.byteLength(doc), meta.bytes);
  assert.ok(doc.includes(`<head>${BRIDGE_PLACEHOLDER}`), 'the bridge placeholder opens <head>');
  assert.ok(doc.includes('data:image/svg+xml;base64,'), 'the logo is inlined');
  assert.doesNotMatch(doc, /(src|href)="\.\.\/assets\//, 'no relative asset reference survives');

  // 4. A version snapshot of the current tree.
  const version = await callJson<CreateVersionResponse>(service, `/designs/${created.slug}/versions`, { method: 'POST', body: { reason: 'manual' } });
  assert.ok(version.created, 'a changed tree makes a version');
  const versions = await callJson<VersionListResponse>(service, `/designs/${created.slug}/versions`);
  assert.equal(versions.versions[0]?.id, version.created.id);
  assert.equal(versions.dirty, false);

  // 5. Exports land in the downloads folder.
  const zip = await callJson<ExportResponse>(service, `/designs/${created.slug}/export`, { method: 'POST', body: { format: 'zip' } });
  assert.equal(path.dirname(zip.path), downloads);
  const names = readZip(await readFile(zip.path)).map((entry) => entry.name);
  for (const name of ['coffee-shop/screens/home.html', 'coffee-shop/assets/logo.svg', 'coffee-shop/assets/site.css']) assert.ok(names.includes(name), `${name} in ${names.join(', ')}`);
  assert.ok(!names.some((name) => name.endsWith('design.json') || name.includes('.versions/') || name.includes('.chamber/')), 'internal files stay out of the ZIP');
  const single = await callJson<ExportResponse>(service, `/designs/${created.slug}/export`, { method: 'POST', body: { format: 'html', screen: 'home' } });
  assert.equal(path.dirname(single.path), downloads);
  const html = await readFile(single.path, 'utf8');
  assert.ok(!html.includes(BRIDGE_PLACEHOLDER), 'exports never carry the bridge placeholder');
  assert.doesNotMatch(html, /(src|href)="\.\.\/assets\//);

  // 6. /chip creates a design with RULES.md and answers the chip text.
  const chip = await callJson<ChipResponse>(service, '/chip', { method: 'POST', body: { kind: 'artifact', brief: 'A pricing page for a coffee subscription' } });
  assert.ok(chip.chip.text.includes('.chamber/RULES.md') || chip.chip.text.includes('.chamber\\RULES.md'));
  await access(path.join(root, chip.slug, '.chamber', 'RULES.md'));

  // 7. Thumbnail (needs Chrome/Edge).
  await t.test('a thumbnail is captured', { timeout: 60_000 }, async (st) => {
    if (!browser) {
      st.skip('Chrome/Edge not found — install one or set DC_TEST_CHROME to run this step.');
      return;
    }
    const deadline = Date.now() + 45_000;
    for (;;) {
      const thumb = await callJson<ThumbnailResponse>(service, `/designs/${created.slug}/thumbnail`);
      assert.ok(thumb.state !== 'failed' && thumb.state !== 'unavailable', `thumbnail ${thumb.state}: ${thumb.message ?? ''}`);
      if (thumb.state === 'ready') {
        assert.ok(thumb.png);
        assert.ok(Buffer.from(thumb.png, 'base64').subarray(1, 4).equals(Buffer.from('PNG')));
        assert.ok(isLaptopThumbSize(thumb), `${thumb.width}×${thumb.height}`);
        break;
      }
      assert.ok(Date.now() < deadline, 'thumbnail not ready within 45 s');
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });

  assert.doesNotMatch(service.output(), new RegExp(service.token), 'the token never reaches the log');
});
