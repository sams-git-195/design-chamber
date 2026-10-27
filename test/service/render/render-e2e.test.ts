// E2E (SPEC §14 WP2): the bundled document renders in headless Chrome with the network
// blocked — inline + external scripts run, inlined images and CSS backgrounds load, computed
// styles come from the inlined stylesheet, and a remote fetch is refused (the same
// --host-resolver-rules the thumbnail capture uses). Skipped (reported, never silent) when
// no Chrome/Edge is installed.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, test, type TestContext } from 'node:test';

import { bundleDocument, createLiveFileSource } from '../../../src/service/bundle.ts';
import { chromeOrSkip, testBrowserFlags } from '../../helpers/chrome-or-skip.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { redPng } from './harness.ts';

const dumpDom = (chrome: string, file: string, work: string): Promise<{ dom: string; code: number | null }> =>
  new Promise((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--hide-scrollbars',
        '--mute-audio',
        ...testBrowserFlags(),
        `--user-data-dir=${path.join(work, 'profile')}`,
        '--host-resolver-rules=MAP * ~NOTFOUND',
        '--virtual-time-budget=4000',
        '--timeout=15000',
        '--dump-dom',
        pathToFileURL(file).href,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let dom = '';
    child.stdout.on('data', (chunk: Buffer) => (dom += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('headless Chrome did not finish within 30 s'));
    }, 30_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ dom, code });
    });
  });

describe('bundled render in headless Chrome (network blocked)', () => {
  test('scripts run, inlined assets load, and remote fetches are blocked', { timeout: 90_000 }, async (t) => {
    const chrome = chromeOrSkip(t);
    if (!chrome) return;
    const tmp = await useTmpRoot(t);
    const work = await mkdtemp(path.join(os.tmpdir(), 'dc-e2e-'));
    t.after(() => rm(work, { recursive: true, force: true }));

    await tmp.writeDesign('e2e', {
      'index.html': `<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="assets/theme.css">
  <script src="assets/app.js"></script>
</head>
<body>
  <h1 id="h1">styled</h1>
  <img id="img" src="assets/pic.png">
  <div id="bg"></div>
  <p id="js">js-not-run</p>
  <p id="imgload">img-not-loaded</p>
  <p id="bgload">bg-unknown</p>
  <p id="net">net-unknown</p>
  <p id="done">not-done</p>
  <script>
    // app.js is inlined into <head>, so it ran before this body script: its marker proves it.
    document.getElementById('js').textContent = window.__appRan === true ? 'js-ran' : 'js-not-run';
    const img = document.getElementById('img');
    const markImg = () => { document.getElementById('imgload').textContent = img.naturalWidth === 1 ? 'img-loaded' : 'img-broken'; };
    if (img.complete) markImg(); else { img.onload = markImg; img.onerror = () => { document.getElementById('imgload').textContent = 'img-error'; }; }
    const bg = getComputedStyle(document.getElementById('bg')).backgroundImage;
    document.getElementById('bgload').textContent = bg.includes('data:image/png;base64,') ? 'bg-inlined' : 'bg-missing:' + bg.slice(0, 30);
    fetch('https://example.com/would-be-remote.json')
      .then(() => { document.getElementById('net').textContent = 'net-WAS-ALLOWED'; finish(); })
      .catch(() => { document.getElementById('net').textContent = 'net-blocked'; finish(); });
    let finished = false;
    function finish() { if (!finished) { finished = true; document.getElementById('done').textContent = 'done'; } }
    setTimeout(finish, 2500);
  </script>
</body>
</html>`,
      'assets/theme.css': '@import "fonts.css";\nh1 { color: rgb(255, 0, 0); }\n#bg { width: 4px; height: 4px; background-image: url(pic.png); }',
      'assets/fonts.css': 'body { font-family: "Definitely Missing Font", serif; }',
      'assets/app.js': 'window.__appRan = true;',
      'assets/pic.png': redPng(),
    });

    const source = createLiveFileSource(tmp.at('e2e'));
    const bundled = await bundleDocument(source, 'index.html', { mode: 'export' });
    assert.equal(bundled.missing.length, 0);
    assert.equal(bundled.blocked.length, 0);
    assert.ok(!bundled.html.includes('assets/'), 'no relative asset reference survives bundling');

    const file = path.join(work, 'bundled.html');
    await writeFile(file, bundled.html, 'utf8');
    const { dom, code } = await dumpDom(chrome, file, work);
    assert.equal(code, 0, `Chrome exited ${code}`);

    assert.match(dom, />js-ran</, 'the inlined external script ran');
    assert.match(dom, />img-loaded</, 'the data: URL image decoded (1×1 px)');
    assert.match(dom, />bg-inlined</, 'the CSS background came from the inlined data URL');
    assert.match(dom, />net-blocked</, 'the remote fetch was blocked (network off)');
    assert.match(dom, />done</, 'the page finished its work');
    // The @import-ed stylesheet applied: h1 computed color would be red; the DOM dump shows
    // the <style> content that produces it.
    assert.ok(dom.includes('color: rgb(255, 0, 0);') || dom.includes('h1 { color: rgb(255, 0, 0); }'), 'the imported stylesheet is present in the bundle');
  });
});
