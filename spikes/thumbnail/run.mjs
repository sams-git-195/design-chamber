// Spike: one-shot headless Chrome screenshot of a local design file, no CDP.
// Proves the thumbnail path: `chrome --headless=new --screenshot` renders a
// file:// HTML page (with its relative assets and scripts) at a layout viewport
// and writes a downscaled PNG via --force-device-scale-factor.
//
// Usage: node spikes/thumbnail/run.mjs [chromePath]
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const chrome = [
  process.argv[2],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find((p) => existsSync(p));
if (!chrome) throw new Error('no Chrome/Edge found');

const work = mkdtempSync(path.join(tmpdir(), 'dc-thumb-'));
const design = path.join(work, 'design');
mkdirSync(path.join(design, 'assets'), { recursive: true });
// 1x1 red PNG as a local asset, stretched by CSS.
writeFileSync(path.join(design, 'assets', 'red.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'));
writeFileSync(path.join(design, 'index.html'), `<!doctype html><html><body style="margin:0;background:#123">
<img src="assets/red.png" style="width:640px;height:400px;display:block">
<h1 id="h" style="color:white;font:48px sans-serif">static</h1>
<script>document.getElementById('h').textContent = 'script ran';</script>
</body></html>`);

const out = path.join(work, 'thumb.png');
const args = [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--mute-audio', `--user-data-dir=${path.join(work, 'profile')}`,
  '--window-size=1280,800', '--force-device-scale-factor=0.25',
  '--virtual-time-budget=1500', `--screenshot=${out}`,
  pathToFileURL(path.join(design, 'index.html')).href,
];
const started = Date.now();
const child = spawn(chrome, args, { stdio: 'ignore' });
const timer = setTimeout(() => child.kill(), 20_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  if (!existsSync(out)) {
    console.log(JSON.stringify({ ok: false, code, chrome }));
    return;
  }
  const png = readFileSync(out);
  // IHDR width/height live at bytes 16..23.
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  console.log(JSON.stringify({ ok: true, chrome, ms: Date.now() - started, width, height, bytes: png.length, out }));
});
