// E2E: the real bridge in a blob frame inside a CSP'd, sandboxed guest page, in headless
// Chrome/Edge (docs/SPEC.md §14 WP4). Harness after spikes/nested-frame/run.mjs:
//   top.html (plain page) → <iframe sandbox="allow-scripts" src="/guest/guest.html">
//   guest.html is served with OpenChamber's guest CSP + `sandbox allow-scripts` and runs
//   test/e2e/bridge-page.ts (bundled with the real bridge), which posts its observations up;
//   top.html POSTs them back to this test. Skips (reported) when no browser is installed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { build, type BuildOptions } from 'esbuild';

import { chromeOrSkip, testBrowserFlags } from '../helpers/chrome-or-skip.ts';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const TIMEOUT_MS = 45_000;

/** OpenChamber's guest frame policy (sdk/src/frame-policy.ts), as in the spike. */
const guestFramePolicy = (connectSource: string): string =>
  [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' 'self' data: blob:",
    "style-src 'unsafe-inline' 'self' data: blob:",
    "img-src 'self' data: blob:",
    "font-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "worker-src 'self' data: blob:",
    "frame-src 'self' data: blob:",
    `connect-src ${connectSource}`,
    "object-src 'none'",
    "form-action 'none'",
  ].join('; ');

const bundle = async (): Promise<string> => {
  const common: BuildOptions & { write: false } = { bundle: true, format: 'iife', platform: 'browser', target: ['es2020'], write: false, logLevel: 'silent', legalComments: 'none' };
  const bridge = await build({ ...common, entryPoints: [path.join(ROOT, 'src', 'guest', 'bridge', 'bridge.ts')], minify: true });
  const bridgeText = bridge.outputFiles?.[0]?.text ?? '';
  assert.ok(bridgeText.length > 0 && !/<\/script/i.test(bridgeText));
  const page = await build({ ...common, entryPoints: [path.join(ROOT, 'test', 'e2e', 'bridge-page.ts')], define: { __DC_BRIDGE__: JSON.stringify(bridgeText) } });
  return page.outputFiles?.[0]?.text ?? '';
};

const TOP = `<!doctype html><html><body>
<iframe sandbox="allow-scripts" src="/guest/guest.html" style="width:1400px;height:900px"></iframe>
<script>
addEventListener('message', (e) => {
  if (e.data && e.data.e2e) fetch('/result', { method: 'POST', body: JSON.stringify(e.data.results) });
});
</script></body></html>`;

type Results = Record<string, unknown> & {
  ready: { docWidth: number; docHeight: number; title: string } | null;
  hit: { selector: string; text: string; html: string; rect: { x: number; y: number; w: number; h: number }; tag: string };
};

const runScenario = async (browser: string): Promise<Results> => {
  const script = (await bundle()).replace(/<\/script/gi, '<\\/script');
  const guest = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${script}</script></body></html>`;
  let resolveResult: (value: Results) => void = () => undefined;
  const result = new Promise<Results>((resolve) => (resolveResult = resolve));

  const server: Server = createServer((req, res) => {
    if (req.url === '/top.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(TOP);
      return;
    }
    if (req.url === '/guest/guest.html') {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': `${guestFramePolicy(`http://127.0.0.1:${port}/guest/`)}; sandbox allow-scripts` });
      res.end(guest);
      return;
    }
    if (req.url === '/result' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      req.on('end', () => {
        res.writeHead(204);
        res.end();
        resolveResult(JSON.parse(body) as Results);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const profile = await mkdtemp(path.join(os.tmpdir(), 'dc-e2e-bridge-'));
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      ...testBrowserFlags(),
      '--window-size=1500,1000',
      `--user-data-dir=${profile}`,
      `http://127.0.0.1:${port}/top.html`,
    ],
    { stdio: 'ignore' },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      result,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`bridge e2e: no result within ${TIMEOUT_MS} ms`)), TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
    server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
  }
};

test('bridge e2e: real bridge in a sandboxed blob frame under the guest CSP', { timeout: 60_000 }, async (t) => {
  const browser = chromeOrSkip(t);
  if (!browser) return;
  const r = await runScenario(browser);
  if (process.env.DC_E2E_DUMP) console.error(JSON.stringify(r, null, 1));
  assert.equal(r.error, undefined, String(r.error));

  // Loaded through frame-doc: bridge first in the (created) <head>, ready reported.
  assert.deepEqual(r.state, { scrollY: 0, title: '', head: true, dc: 'object' });
  assert.ok(r.ready && r.ready.docWidth >= 1200 && r.ready.docHeight >= 2400, JSON.stringify(r.ready));

  // Hover hit-test: selector, text, opening tag, document rect.
  assert.equal(r.hit.tag, 'h1');
  assert.equal(r.hit.selector, 'h1.hero-title');
  assert.equal(r.hit.text, 'Fresh roasts, every other Monday');
  assert.equal(r.hit.html, '<h1 class="hero-title is-active" style="position:absolute;left:50px;top:100px;width:400px;height:60px;margin:0">');
  assert.deepEqual(r.hit.rect, { x: 50, y: 100, w: 400, h: 60 });
  assert.equal(r.hitEmpty, null, 'body/html are not commentable');

  // Anchors resolved in the frame and placed by the page-side tracker.
  const pins = r.pins as { commentId: string; state: string; rect: { y: number } }[];
  assert.deepEqual(
    pins.map((pin) => [pin.commentId, pin.state]),
    [
      ['c_exact', 'exact'],
      ['c_moved', 'moved'],
      ['c_gone', 'detached'],
    ],
  );
  assert.equal(pins[0]?.rect.y, 100);
  assert.ok((r.size as { docHeight: number }).docHeight >= 4000, 'size report after the document grew');

  // Scroll sync, and rects stay in document px while scrolled.
  assert.equal((r.scrollTo as { y: number }).y, 500);
  assert.equal((r.scrollBy as { y: number }).y, 600);
  assert.deepEqual(r.anchorAfterScroll, { x: 50, y: 100, w: 400, h: 60 });

  // Highlight overlay drawn and cleared; never intercepts input.
  assert.match(String(r.overlay), /left:50px;top:100px;width:400px;height:60px;.*pointer-events:none/);
  assert.equal(r.overlayCleared, null);

  // Wheel (ctrl → forwarded, lines → px) and wall keys (not from inputs).
  assert.deepEqual(pick(r.wheel, ['deltaY', 'ctrl', 'x', 'y']), { deltaY: 48, ctrl: true, x: 10, y: 20 });
  assert.deepEqual(pick(r.key, ['key', 'ctrl', 'shift']), { key: 'Escape', ctrl: false, shift: false });
  assert.equal(r.keyInInput, 'none');
  assert.equal(r.playPlainWheel, 'none', 'Play mode: a plain wheel scrolls the design, not the wall');

  // Play-mode link interception; the document never navigates away.
  assert.equal(r.clickPricing, 'blob:');
  assert.deepEqual(pick(r.navigate, ['href', 'hash']), { href: 'screens/pricing.html', hash: '#plans' });
  assert.deepEqual(pick(r.external, ['url']), { url: 'https://example.com/about?x=1' });
  assert.deepEqual(pick(r.goto, ['href', 'hash']), { href: 'screens/checkout.html', hash: '' });
  assert.deepEqual(r.jsLink, ['none', 'none']);
  assert.ok((r.fragment as { y: number }).y > 1000, 'in-page #fragment scrolls');
  assert.equal(r.submit, 'blob:', 'form submit prevented');

  // Validation: wrong nonce, foreign source, self-posted commands — all ignored.
  assert.equal(r.forgedNonce, 'none');
  assert.equal(r.intruderPosted, true, 'positive control: the foreign frame did post');
  assert.equal(r.foreignSource, 'none');
  assert.notEqual(r.selfPost, 7, 'the bridge ignores messages that are not from its parent');
  assert.equal(r.escapeTop, 'denied');
  assert.deepEqual(r.inboxTypes, ['anchors', 'hit', 'key', 'navigate', 'open-external', 'ready', 'scroll', 'size', 'wheel']);
});

const pick = (value: unknown, keys: string[]): Record<string, unknown> | unknown => {
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(keys.map((key) => [key, record[key]]));
};
