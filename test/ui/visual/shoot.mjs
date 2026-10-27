// Visual check of the built UI (not part of `npm test`): serves dist/panel behind a mock host
// page — with main.js swapped for a bundle of `fake-main.ts` (the real UI and guest core, the
// local service replaced by the in-memory fake backend) — drives headless Chrome over the DevTools protocol (no extra dependency — Node's global
// WebSocket), walks every screen at rail widths 320/480 and the 1400 px page in the dark and light
// OpenChamber themes, and saves PNGs.
//
//   npm run build && node test/ui/visual/shoot.mjs [filter] [--out documentation/pages/img]
//
// `filter` is a regex tested against "<kind>-<width>-<theme>" (e.g. `rail-320`, `page.*light`).
// Exit code 1 when a guest console error or an assertion fails.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const outDir = path.resolve(root, outIndex >= 0 ? (args[outIndex + 1] ?? '') : 'documentation/pages/img');
const filter = new RegExp(args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--out') ?? '.');
mkdirSync(outDir, { recursive: true });

const chromePath = [
  process.env.DC_TEST_CHROME,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
if (!chromePath) throw new Error('No Chrome or Edge found; set DC_TEST_CHROME.');

// ---------------------------------------------------------------- harness bundle (same bridge as scripts/build.mjs)

const browser = { bundle: true, format: 'iife', platform: 'browser', target: ['es2020'], write: false, logLevel: 'warning', legalComments: 'none' };
const bridge = (await build({ ...browser, entryPoints: [path.join(root, 'src', 'guest', 'bridge', 'bridge.ts')], minify: true })).outputFiles[0].text;
const harnessJs = (await build({ ...browser, entryPoints: [path.join(here, 'fake-main.ts')], define: { __DC_BRIDGE__: JSON.stringify(bridge) } })).outputFiles[0].text;

// ---------------------------------------------------------------- static server

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://x');
  let file;
  if (url.pathname === '/panel/main.js') {
    response.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-store' }).end(harnessJs);
    return;
  }
  if (url.pathname === '/host.html') file = path.join(here, 'host.html');
  else if (url.pathname.startsWith('/panel/')) file = path.join(root, 'dist', url.pathname);
  else {
    response.writeHead(404).end();
    return;
  }
  try {
    response.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(file));
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

// ---------------------------------------------------------------- chrome + CDP

const profile = path.join(tmpdir(), `dc-visual-${process.pid}`);
const debugPort = 9300 + Math.floor(Math.random() * 400);
const chrome = spawn(chromePath, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--headless=new', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', '--disable-extensions', 'about:blank'], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (fn, what, timeout = 15000) => {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${what}`);
    await sleep(60);
  }
};

const version = await until(async () => {
  try {
    return await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
  } catch {
    return null;
  }
}, 'Chrome to start', 20000);
void version;

const problems = [];

const openPage = async ({ width, height, surface, theme, label }) => {
  const target = await (await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' })).json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let seq = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && waiting.has(message.id)) {
      const { resolve, reject } = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}`));
      else resolve(message.result);
    } else if (message.method === 'Runtime.exceptionThrown') {
      problems.push(`[${label}] exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`);
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      problems.push(`[${label}] console.error: ${message.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 400)}`);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      seq += 1;
      waiting.set(seq, { resolve, reject });
      socket.send(JSON.stringify({ id: seq, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: `${base}/host.html?surface=${surface}&theme=${theme}` });

  // Run `code` inside the guest document. `doc` and `win` are the guest's document and window.
  const guest = async (code) => {
    const result = await send('Runtime.evaluate', {
      expression: `(() => { const g = document.getElementById('g'); const win = g && g.contentWindow; const doc = win && win.document; if (!doc || !doc.body) return null; ${code} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(`guest eval failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n${code}`);
    return result.result.value;
  };
  const host = async (code) => (await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true })).result.value;

  const rect = (selector, nth = 0, text = null) =>
    guest(`
      const nodes = [...doc.querySelectorAll(${JSON.stringify(selector)})].filter((n) => n.offsetParent !== null || n.getClientRects().length);
      const list = ${JSON.stringify(text)} === null ? nodes : nodes.filter((n) => (n.textContent || '').trim().includes(${JSON.stringify(text)}) || (n.getAttribute('aria-label') || '').includes(${JSON.stringify(text)}));
      const el = list[${nth}];
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };`);

  const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });
  const api = {
    send,
    guest,
    host,
    rect,
    async settle(ms = 350) {
      await sleep(ms);
    },
    async waitFor(code, what, timeout) {
      return until(() => guest(code).catch(() => null), what ?? code, timeout);
    },
    async move(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    },
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await mouse('mousePressed', x, y);
      await mouse('mouseReleased', x, y);
    },
    async click(selector, opts = {}) {
      const r = await until(() => rect(selector, opts.nth ?? 0, opts.text ?? null), `element ${selector}${opts.text ? ` "${opts.text}"` : ''}`);
      await api.clickAt(r.x + (opts.dx ?? r.w / 2), r.y + (opts.dy ?? r.h / 2));
      await sleep(opts.wait ?? 120);
    },
    async hover(selector, opts = {}) {
      const r = await until(() => rect(selector, opts.nth ?? 0, opts.text ?? null), `element ${selector}`);
      await api.move(r.x + r.w / 2, r.y + r.h / 2);
      await sleep(120);
    },
    async type(selector, text) {
      await guest(`const el = doc.querySelector(${JSON.stringify(selector)}); el.focus(); if (el.select) el.select();`);
      await send('Input.insertText', { text });
      await sleep(80);
    },
    // Headless Chrome drops guest focus after a synthesized key, so a keyboard test names the element to refocus first.
    async key(key, { code = key, shift = false, ctrl = false, focus = null } = {}) {
      if (focus) await guest(`doc.querySelector(${JSON.stringify(focus)}).focus()`);
      const modifiers = (shift ? 8 : 0) | (ctrl ? 2 : 0);
      const text = key.length === 1 ? key : undefined;
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, text, windowsVirtualKeyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : { Escape: 27, Enter: 13, ArrowRight: 39, ArrowLeft: 37, ArrowDown: 40, ArrowUp: 38, Tab: 9 }[key] });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers });
      await sleep(80);
    },
    async wheel(x, y, deltaX, deltaY, { ctrl = false } = {}) {
      await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY, modifiers: ctrl ? 2 : 0 });
      await sleep(120);
    },
    async shot(name) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(outDir, `${name}.png`);
      writeFileSync(file, Buffer.from(data, 'base64'));
      console.log(`  saved ${path.relative(root, file)}`);
    },
    async close() {
      socket.close();
      await fetch(`http://127.0.0.1:${debugPort}/json/close/${target.id}`).catch(() => undefined);
    },
  };
  await api.waitFor('return !!doc.querySelector(".dc-app")', 'the app to mount');
  return api;
};

// ---------------------------------------------------------------- scenarios

const check = (condition, message) => {
  if (!condition) {
    problems.push(`ASSERT: ${message}`);
    console.log(`  ✗ ${message}`);
  } else console.log(`  ✓ ${message}`);
};

const listReady = (p) => p.waitFor('return doc.querySelectorAll(".dc-row[data-slug], .dc-card[data-slug]").length >= 5', 'the list rows');
const thumbsReady = (p) => p.waitFor('const t = [...doc.querySelectorAll(".dc-thumb")]; return t.length > 0 && t.every((n) => n.dataset.state !== "loading")', 'thumbnails', 20000).catch(() => undefined);
const wallReady = (p, n = 1) =>
  p.waitFor(`return doc.querySelectorAll('.dc-board[data-state="ready"]').length >= ${n}`, 'artboards to render', 20000).catch(async (error) => {
    console.log('  state:', await p.guest('return JSON.stringify({ app: doc.querySelector(".dc-app")?.innerHTML.slice(0, 300), sheets: [...doc.querySelectorAll(".dc-sheet")].map((n) => n.dataset.variant + ":" + n.querySelector(".dc-sheet-title")?.textContent), active: doc.activeElement?.outerHTML.slice(0, 120), boards: [...doc.querySelectorAll(".dc-board")].map((b) => b.dataset.state) })'));
    throw error;
  });
const menuItem = (p, text) => p.click('.dc-popup [role="menuitem"]', { text });
const scaleLabel = (p) => p.guest('return doc.querySelector(".dc-zoom-label")?.textContent?.trim() ?? null');

const railScenario = async (width, theme) => {
  const tag = `rail-${width}-${theme}`;
  const p = await openPage({ width, height: 780, surface: 'panel', theme, label: tag });
  console.log(`${tag}`);
  await listReady(p);
  await thumbsReady(p);
  await p.settle(300);
  check(await p.guest('return doc.documentElement.scrollWidth <= doc.documentElement.clientWidth'), `${tag}: no horizontal overflow in the list`);
  await p.shot(`${tag}-1-list`);

  const selectedTab = () => p.guest('return doc.querySelector(".dc-tabs [role=tab][aria-selected=true]")?.dataset.id ?? null');
  const rowCount = () => p.guest('return doc.querySelectorAll(".dc-row[data-slug]").length');
  const allRows = await rowCount();
  await p.click('.dc-tabs [role=tab]', { text: 'Canvases' });
  await p.settle(150);
  check((await selectedTab()) === 'canvas', `${tag}: clicking Canvases selects it`);
  check(await p.guest('return [...doc.querySelectorAll(".dc-row[data-slug]")].every((n) => n.querySelector(".dc-row-meta")?.textContent.startsWith("Canvas"))'), `${tag}: Canvases lists only canvases`);
  await p.click('.dc-tabs [role=tab]', { text: 'All' });
  await p.settle(150);
  check((await selectedTab()) === 'all' && (await rowCount()) === allRows, `${tag}: clicking All goes back to all designs`);

  await p.hover('.dc-row[data-slug="coffee-subscription"]');
  await p.click('.dc-row[data-slug="coffee-subscription"] .dc-iconbtn');
  await p.shot(`${tag}-2-row-menu`);
  await p.key('Escape');

  await p.click('.dc-rail-head .oc-sdk-btn', { text: 'New' });
  await menuItem(p, 'Canvas');
  await p.waitFor('return !!doc.querySelector(".dc-sheet[data-variant=dialog] textarea")', 'the New dialog');
  await p.type('.dc-sheet textarea', 'A pricing page for a coffee subscription, laptop and phone');
  await p.settle(300);
  await p.shot(`${tag}-3-new-dialog`);
  await p.key('Escape');

  await p.click('.dc-rail-head .dc-iconbtn[aria-label="Settings"]');
  await p.waitFor('return !!doc.querySelector(".dc-settings .dc-code")', 'settings');
  await p.settle(300);
  await p.shot(`${tag}-4-settings`);
  await p.guest('doc.querySelector(".dc-sheet-body").scrollTop = 9999');
  await p.shot(`${tag}-4b-settings-bottom`);
  await p.key('Escape');

  await p.click('.dc-row[data-slug="coffee-subscription"] .dc-row-main');
  await wallReady(p, 2);
  await p.settle(500);
  await p.shot(`${tag}-5-viewer-canvas`);

  await p.click('.dc-toolbar-compact .dc-iconbtn[aria-label="More actions"]');
  await p.shot(`${tag}-6-viewer-menu`);
  await menuItem(p, 'Comments');
  await p.waitFor('return !!doc.querySelector(".dc-comment")', 'comments');
  await p.settle(200);
  await p.shot(`${tag}-7-comments`);
  await p.key('Escape');

  await p.click('.dc-toolbar-compact .dc-iconbtn[aria-label="More actions"]');
  await menuItem(p, 'Versions');
  await p.waitFor('return !!doc.querySelector(".dc-version")', 'versions');
  await p.settle(200);
  await p.shot(`${tag}-8-versions`);
  await p.key('Escape');

  await p.click('.dc-toolbar-compact .dc-iconbtn[aria-label="Back to designs"]');
  await p.click('.dc-row[data-slug="northwind-pricing"] .dc-row-main');
  await wallReady(p, 1);
  await p.settle(600);
  await p.shot(`${tag}-9-viewer-artifact`);
  await p.close();
};

const pageScenario = async (width, theme) => {
  const tag = `page-${width}-${theme}`;
  const p = await openPage({ width, height: 900, surface: 'page', theme, label: tag });
  console.log(`${tag}`);
  await listReady(p);
  await thumbsReady(p);
  await p.settle(400);
  await p.shot(`${tag}-1-library`);

  // canvas wall
  await p.click('.dc-card[data-slug="coffee-subscription"] .dc-card-main');
  await wallReady(p, 6);
  await p.settle(700);
  await p.shot(`${tag}-2-wall`);

  // zoom around the cursor: the world point under the cursor must not move.
  const before = await scaleLabel(p);
  await p.wheel(700, 450, 0, -300, { ctrl: true });
  const after = await scaleLabel(p);
  check(before !== after, `${tag}: ctrl+wheel zooms (${before} → ${after})`);
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Fit' });
  await p.wheel(500, 400, 0, 200);
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Fit' });
  await p.key('1', { code: 'Digit1', shift: true });

  // edit: hover outline + composer
  await p.guest('doc.querySelector(".dc-wall").focus()');
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Fit' });
  const zoomTarget = await p.rect('.dc-board[data-board="home@laptop"]');
  // zoom in on the home laptop board (about 2×) to make hover targets comfortable.
  await p.wheel(zoomTarget.x + zoomTarget.w / 2, zoomTarget.y + zoomTarget.h / 2, 0, -130, { ctrl: true });
  await p.settle(500);
  const home = await p.rect('.dc-board[data-board="home@laptop"]');
  await p.move(home.x + home.w * 0.2, home.y + home.h * 0.22);
  await p.settle(400);
  check(await p.guest('const h = doc.querySelector(".dc-board[data-board=\\"home@laptop\\"] .dc-hover"); return !!h && !h.hidden'), `${tag}: Edit mode outlines the element under the cursor`);
  await p.shot(`${tag}-3-hover`);
  await p.clickAt(home.x + home.w * 0.2, home.y + home.h * 0.22);
  await p.waitFor('return !!doc.querySelector(".dc-composer")', 'the comment composer');
  await p.type('.dc-composer textarea', 'Make this headline shorter');
  await p.settle(200);
  await p.shot(`${tag}-4-composer`);
  await p.key('Enter', { ctrl: true });
  await p.waitFor('return !doc.querySelector(".dc-composer")', 'composer to close');
  await p.settle(500);
  check((await p.guest('return doc.querySelectorAll(".dc-board[data-board=\\"home@laptop\\"] .dc-pin:not(.dc-temp-pin)").length')) >= 3, `${tag}: the new comment appears as a pin`);
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Fit' });
  await p.settle(400);
  await p.shot(`${tag}-5-pins`);

  // zoomed far out, pins that would overlap fold into one count badge; a click zooms in on them.
  await p.guest('doc.querySelector(".dc-wall").focus()');
  for (let i = 0; i < 6; i += 1) await p.key('-', { focus: '.dc-wall' });
  await p.settle(300);
  check((await p.guest('return doc.querySelectorAll(".dc-pin-cluster").length')) > 0, `${tag}: overlapping pins fold into a count at ${await scaleLabel(p)}`);
  check(await p.guest('const pins = [...doc.querySelectorAll(".dc-board-overlay[data-pins=shown] .dc-pin")].filter((n) => !n.hidden).map((n) => n.getBoundingClientRect()); return pins.every((a, i) => pins.every((b, j) => i === j || Math.hypot(a.x - b.x, a.y - b.y) >= Math.min(a.width, b.width) - 1))'), `${tag}: no two visible pins overlap`);
  await p.shot(`${tag}-5b-pins-clustered`);
  const zoomedOut = await scaleLabel(p);
  await p.click('.dc-pin-cluster');
  await p.settle(300);
  check((await scaleLabel(p)) !== zoomedOut, `${tag}: clicking a count zooms in (${zoomedOut} → ${await scaleLabel(p)})`);
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Fit' });

  // thread popover
  await p.click('.dc-board[data-board="home@laptop"] .dc-pin:not(.dc-temp-pin)');
  await p.waitFor('return !!doc.querySelector(".dc-thread")', 'the thread popover');
  await p.shot(`${tag}-6-thread`);
  await p.key('Escape');

  // comments drawer
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Comments' });
  await p.waitFor('return !!doc.querySelector(".dc-comment")', 'comments drawer');
  await p.settle(300);
  await p.shot(`${tag}-7-comments`);
  await p.click('.dc-comments-tabs [role=tab]', { text: 'Sent' });
  await p.settle(150);
  await p.shot(`${tag}-7b-comments-sent`);
  await p.click('.dc-comments-tabs [role=tab]', { text: 'Open' });

  // versions: view + compare
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Versions' });
  await p.waitFor('return !!doc.querySelector(".dc-version")', 'versions drawer');
  await p.settle(200);
  await p.click('.dc-version .oc-sdk-btn', { text: 'Compare', nth: 2 });
  await p.waitFor('return !!doc.querySelector(".dc-viewing")', 'the viewing banner');
  await wallReady(p, 6);
  await p.settle(900);
  await p.shot(`${tag}-8-versions-compare`);
  await p.click('.dc-viewing .oc-sdk-btn', { text: 'Back to current' });
  await p.settle(500);

  // play mode
  await p.click('.dc-toolbar [role=tab]', { text: 'Play' });
  await p.settle(500);
  await p.shot(`${tag}-9-play`);
  await p.click('.dc-toolbar [role=tab]', { text: 'Edit' });

  // library back, artifact viewer
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Library' });
  await p.click('.dc-card[data-slug="northwind-pricing"] .dc-card-main');
  await wallReady(p, 1);
  await p.settle(700);
  await p.shot(`${tag}-10-artifact`);
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Export' });
  await p.shot(`${tag}-11-artifact-export-menu`);
  await menuItem(p, 'Download ZIP');
  await p.waitFor('return !!doc.querySelector(".dc-notices .oc-sdk-banner")', 'export notice');
  await p.settle(300);
  check((await p.host('JSON.stringify(window.__host.toasts.map((t) => t.message))')).includes('Saved to'), `${tag}: export toast with the saved path`);
  await p.shot(`${tag}-12-artifact-exported`);
  await p.click('.dc-toolbar .oc-sdk-btn', { text: 'Library' });

  // settings sheet
  await p.click('.dc-library-bar .oc-sdk-btn', { text: 'Settings' });
  await p.waitFor('return !!doc.querySelector(".dc-settings .dc-code")', 'settings');
  await p.settle(300);
  await p.shot(`${tag}-13-settings`);
  await p.key('Escape');
  await p.close();
};

// Keyboard paths of the wall and live refresh while the agent writes files.
const keyboardAndLive = async () => {
  const tag = 'page-1400-dark-live';
  const p = await openPage({ width: 1400, height: 900, surface: 'page', theme: 'dark', label: tag });
  console.log(tag);
  await listReady(p);
  await thumbsReady(p);
  check(await p.guest('return !!doc.querySelector(".dc-card[data-slug=\\"onboarding-flow\\"] .dc-card-overlay")'), `${tag}: a pending design shows "Waiting for agent"`);
  await p.click('.dc-card[data-slug="onboarding-flow"] .dc-card-main');
  await p.waitFor('return doc.querySelectorAll(".dc-board[data-state=\\"missing\\"]").length >= 3', 'missing placeholders');
  await p.settle(300);
  await p.shot(`${tag}-1-not-written`);
  check(await p.guest('return !!doc.querySelector(".dc-placeholder-title")?.textContent.includes("isn’t written yet")'), `${tag}: an unwritten screen says so`);
  await p.host('window.frames[0].__dcFake.writePending()');
  await wallReady(p, 3);
  await p.settle(600);
  await p.shot(`${tag}-2-written`);

  // keyboard: focus the wall, zoom with +/-, pan with arrows, Shift+1 fits, H toggles the pan tool.
  await p.guest('doc.querySelector(".dc-wall").focus()');
  const label = () => scaleLabel(p);
  const first = await label();
  await p.key('+', { focus: '.dc-wall' });
  const zoomed = await label();
  check(first !== zoomed, `${tag}: "+" zooms in (${first} → ${zoomed})`);
  await p.key('-', { focus: '.dc-wall' });
  const transform = () => p.guest('return doc.querySelector(".dc-wall-world").style.transform');
  const before = await transform();
  await p.key('ArrowRight', { focus: '.dc-wall' });
  check(before !== (await transform()), `${tag}: arrow keys pan the wall`);
  await p.key('h', { focus: '.dc-wall' });
  check((await p.guest('return doc.querySelector(".dc-wall").dataset.tool')) === 'pan', `${tag}: H switches to the pan tool`);
  await p.key('h', { focus: '.dc-wall' });
  await p.key('1', { code: 'Digit1', shift: true, focus: '.dc-wall' });
  await p.key('0', { code: 'Digit0', shift: true, focus: '.dc-wall' });
  check((await label()) === '100%', `${tag}: Shift+0 resets to 100%`);

  // drag-free zoom controls and viewport chips stay reachable by keyboard: Tab from the title reaches the mode tabs.
  await p.guest('doc.querySelector(".dc-title-input").focus()');
  await p.key('Tab');
  check(await p.guest('return doc.activeElement.closest(".dc-toolbar") !== null'), `${tag}: Tab moves through the toolbar`);

  // a viewport chip hides one column and keeps one visible.
  await p.click('.dc-chips .oc-sdk-btn', { text: 'Phone' });
  await p.settle(300);
  check((await p.guest('return doc.querySelectorAll(".dc-board").length')) === 3, `${tag}: hiding Phone leaves the Laptop column`);
  await p.click('.dc-chips .oc-sdk-btn', { text: 'Laptop' });
  await p.settle(300);
  check((await p.guest('return doc.querySelectorAll(".dc-board").length')) === 3, `${tag}: the last visible size cannot be hidden`);
  await p.close();
};

const themeSwitch = async () => {
  const tag = 'rail-360-themeswitch';
  const p = await openPage({ width: 360, height: 700, surface: 'panel', theme: 'dark', label: tag });
  console.log(tag);
  await listReady(p);
  const dark = await p.guest('return getComputedStyle(doc.body).backgroundColor');
  await p.host('window.__host.setTheme("light")');
  await p.settle(400);
  const light = await p.guest('return getComputedStyle(doc.body).backgroundColor');
  check(dark !== light, `${tag}: a theme switch repaints live (${dark} → ${light})`);
  await p.close();
};

const emptyAndErrors = async () => {
  const tag = 'rail-320-dark-empty';
  const p = await openPage({ width: 320, height: 700, surface: 'panel', theme: 'dark', label: tag });
  console.log(tag);
  await listReady(p);
  await p.click('.dc-rail-head .dc-iconbtn[aria-label="Settings"]');
  await p.waitFor('return !!doc.querySelector(".dc-settings input")', 'settings');
  await p.type('.dc-settings input', 'relative/folder');
  await p.click('.dc-settings .oc-sdk-btn', { text: 'Apply folder' });
  await p.settle(200);
  await p.shot(`${tag}-1-folder-invalid`);
  check(await p.guest('return !!doc.querySelector(".dc-settings .oc-sdk-field-note")?.textContent?.includes("full path")'), `${tag}: invalid folder says what to do`);
  await p.type('.dc-settings input', 'D:\\Elsewhere\\Designs');
  await p.click('.dc-settings .oc-sdk-btn', { text: 'Apply folder' });
  await p.settle(900);
  await p.shot(`${tag}-2-folder-changed`);
  await p.key('Escape');
  await p.waitFor('return !!doc.querySelector(".dc-list-message")', 'the empty state');
  await p.settle(300);
  await p.shot(`${tag}-3-empty`);
  await p.close();
};

const plan = [];
for (const theme of ['dark', 'light']) {
  for (const width of [320, 480]) plan.push([`rail-${width}-${theme}`, () => railScenario(width, theme)]);
  plan.push([`page-1400-${theme}`, () => pageScenario(1400, theme)]);
}
plan.push(['rail-360-themeswitch', themeSwitch]);
plan.push(['page-1400-dark-live', keyboardAndLive]);
plan.push(['rail-320-dark-empty', emptyAndErrors]);

let failed = false;
try {
  for (const [name, run] of plan) {
    if (!filter.test(name)) continue;
    try {
      await run();
    } catch (error) {
      failed = true;
      console.log(`  ✗ ${name} crashed: ${error.message}`);
      problems.push(`${name}: ${error.message}`);
    }
  }
} finally {
  chrome.kill();
  server.close();
  await sleep(300);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    // Chrome may still hold the profile for a moment; it is a temp directory.
  }
}
if (problems.length > 0) {
  console.log(`\n${problems.length} problem(s):`);
  for (const problem of [...new Set(problems)]) console.log(`  - ${problem}`);
  process.exit(1);
}
if (failed) process.exit(1);
console.log('\nall visual checks passed');
