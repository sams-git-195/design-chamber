// Smoke-test driver (QA tooling, not shipped). Drives a headless Chrome that has the running
// OpenChamber web UI open, including its sandboxed guest iframes, over the DevTools protocol.
//
//   chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<tmp> about:blank
//   node cdp-driver.mjs serve            # daemon on 127.0.0.1:9334
//   curl -s -X POST localhost:9334 -d '{"op":"goto","url":"http://127.0.0.1:57123/"}'
//
// Ops: goto, eval(frame,expr), click(x,y|frame+sel|frame+text), type(text), key(key,mods),
// wheel(x,y,dx,dy,ctrl), drag(from,to), shot(path), frames, viewport(w,h,scale), sleep(ms).
// `frame` is "top" or a substring of a frame URL (default "guest-files"); the guest is
// resolved to its iframe target (or an isolated world when it shares the page process).
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const CDP = process.env.CDP ?? 'http://127.0.0.1:9333';
const PORT = Number(process.env.DRIVER_PORT ?? 9334);

let ws; let nextId = 1; const pending = new Map(); const sessions = new Map();
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, { resolve, reject, method });
  ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const page = list.find((t) => t.type === 'page' && t.url.startsWith(process.env.OC_URL ?? 'http://127.0.0.1:57123'));
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((ok, bad) => { ws.onopen = ok; ws.onerror = bad; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(`${p.method}: ${m.error.message}`)) : p.resolve(m.result);
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
}

// Find the execution context for a frame whose URL contains `needle`.
async function resolveFrame(needle) {
  if (needle === 'top') return { sessionId: undefined, contextId: undefined, offset: { x: 0, y: 0 } };
  const { frameTree } = await send('Page.getFrameTree');
  const walk = (t, acc = []) => { acc.push(t.frame); (t.childFrames ?? []).forEach((c) => walk(c, acc)); return acc; };
  const frames = walk(frameTree);
  const f = frames.find((x) => x.url.includes(needle));
  if (f) {
    const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: f.id, worldName: 'dc-smoke', grantUniveralAccess: true });
    const { backendNodeId } = await send('DOM.getFrameOwner', { frameId: f.id });
    return { sessionId: undefined, contextId: executionContextId, ownerNode: backendNodeId };
  }
  const { targetInfos } = await send('Target.getTargets');
  const t = targetInfos.find((x) => x.type === 'iframe' && x.url.includes(needle));
  if (!t) throw new Error(`frame not found: ${needle}`);
  const { sessionId } = await send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
  await send('Runtime.enable', {}, sessionId);
  return { sessionId, contextId: undefined, oopif: true, targetId: t.targetId };
}

// "guest-files" = the widest guest iframe (the full-screen page), "guest-files:rail" = the narrowest (rail panel).
async function canon(frame) {
  if (frame !== 'guest-files' && frame !== 'guest-files:rail') return frame;
  const r = await send('Runtime.evaluate', { expression: `[...document.querySelectorAll('iframe')].filter(i => (i.src||'').includes('guest-files')).map(i => ({ src: i.src, w: i.getBoundingClientRect().width * i.getBoundingClientRect().height }))`, returnByValue: true });
  const list = r.result.value.sort((a, b) => b.w - a.w);
  if (!list.length) throw new Error('no guest iframe');
  return (frame === 'guest-files' ? list[0] : list[list.length - 1]).src;
}

async function evalIn(frame, expression, awaitPromise = true) {
  frame = await canon(frame);
  const r = await resolveFrame(frame);
  const res = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, ...(r.contextId ? { contextId: r.contextId } : {}) }, r.sessionId);
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  return res.result.value;
}

// Page-space offset of the frame's top-left corner (sum of iframe owner rects up the chain).
async function frameOffset(frame) {
  if (frame === 'top') return { x: 0, y: 0 };
  // The guest iframe element is in the top document; nested frames are not needed for clicks.
  return evalIn('top', `(() => { const f = [...document.querySelectorAll('iframe')].find(i => (i.src||'').includes(${JSON.stringify(frame)})); if (!f) return null; const r = f.getBoundingClientRect(); return { x: r.x, y: r.y }; })()`);
}

const FIND = (sel, text, nth = 0) => `(() => {
  const sel = ${JSON.stringify(sel ?? '*')}; const text = ${JSON.stringify(text ?? null)};
  const els = [...document.querySelectorAll(sel)].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const pick = text == null ? els[${nth}] : (els.filter((e) => norm(e.getAttribute('aria-label')) === text || norm(e.textContent) === text)[${nth}]
    ?? els.filter((e) => norm(e.getAttribute('aria-label')).includes(text) || norm(e.textContent).includes(text)).sort((a, b) => norm(a.textContent).length - norm(b.textContent).length)[0]);
  if (!pick) return null; const r = pick.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
})()`;

async function point(op) {
  if (op.x != null) return { x: op.x, y: op.y };
  const frame = op.frame ?? 'guest-files';
  const r = await evalIn(frame, FIND(op.sel, op.text, op.nth));
  if (!r) throw new Error(`not found: ${op.sel ?? ''} ${op.text ?? ''} in ${frame}`);
  const off = await frameOffset(await canon(frame));
  return { x: r.x + off.x, y: r.y + off.y };
}

const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1, ...extra });

const KEYS = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, ' ': 32, Delete: 46 };
async function key(k, mods = 0) {
  const code = KEYS[k] ?? (k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0);
  const text = k.length === 1 && !(mods & 6) ? k : (k === 'Enter' ? '\r' : undefined);
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: /[0-9]/.test(k) ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, modifiers: mods, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: /[0-9]/.test(k) ? `Digit${k}` : k.length === 1 ? `Key${k.toUpperCase()}` : k, windowsVirtualKeyCode: code, modifiers: mods });
}

const ops = {
  async goto(o) { await send('Page.navigate', { url: o.url }); await sleep(o.wait ?? 2500); return 'ok'; },
  eval: (o) => evalIn(o.frame ?? 'guest-files', o.expr),
  async frames() { const { frameTree } = await send('Page.getFrameTree'); const out = []; (function w(t, d) { out.push(`${'  '.repeat(d)}${t.frame.url.slice(0, 120)}`); (t.childFrames ?? []).forEach((c) => w(c, d + 1)); })(frameTree, 0); const { targetInfos } = await send('Target.getTargets'); return { frames: out, targets: targetInfos.map((t) => `${t.type} ${t.url.slice(0, 100)}`) }; },
  async click(o) { const p = await point(o); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await mouse('mousePressed', p.x, p.y, o.right ? { button: 'right', buttons: 2 } : {}); await mouse('mouseReleased', p.x, p.y, o.right ? { button: 'right' } : {}); await sleep(o.wait ?? 400); return p; },
  // Wheel straight into the guest's own session (guest-relative x,y): the page-level route does not reach OOPIFs in headless.
  async wheelg(o) {
    const frame = await canon(o.frame ?? 'guest-files'); const r = await resolveFrame(frame);
    await Promise.race([send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: o.x, y: o.y, deltaX: o.dx ?? 0, deltaY: o.dy ?? 0, modifiers: o.ctrl ? 2 : 0, pointerType: 'mouse' }, r.sessionId), sleep(2500)]);
    await sleep(o.wait ?? 300); return 'ok';
  },
  async scheme(o) { await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.value }] }); await sleep(o.wait ?? 1500); return o.value; },
  async front() { await send('Page.bringToFront'); await send('Emulation.setFocusEmulationEnabled', { enabled: true }); return 'ok'; },
  async hover(o) { const p = await point(o); await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y }); await sleep(o.wait ?? 300); return p; },
  async type(o) { await send('Input.insertText', { text: o.text }); await sleep(200); if (o.enter) await key('Enter'); return 'ok'; },
  async key(o) { await key(o.key, (o.ctrl ? 2 : 0) | (o.shift ? 8 : 0) | (o.alt ? 1 : 0)); await sleep(o.wait ?? 300); return 'ok'; },
  async wheel(o) { const p = await point(o); await Promise.race([send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: o.dx ?? 0, deltaY: o.dy ?? 0, modifiers: o.ctrl ? 2 : 0 }), sleep(2500)]); await sleep(o.wait ?? 300); return p; },
  async drag(o) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: o.from.x, y: o.from.y });
    await mouse('mousePressed', o.from.x, o.from.y, o.button === 'middle' ? { button: 'middle', buttons: 4 } : {});
    const steps = 12; for (let i = 1; i <= steps; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: o.from.x + (o.to.x - o.from.x) * i / steps, y: o.from.y + (o.to.y - o.from.y) * i / steps, buttons: 1 }); await sleep(15); }
    await mouse('mouseReleased', o.to.x, o.to.y, o.button === 'middle' ? { button: 'middle', buttons: 0 } : {}); await sleep(300); return 'ok';
  },
  async shot(o) {
    const params = { format: 'png', ...(o.clip ? { clip: { ...o.clip, scale: 1 } } : {}) };
    const { data } = await send('Page.captureScreenshot', params);
    mkdirSync(dirname(o.path), { recursive: true }); writeFileSync(o.path, Buffer.from(data, 'base64')); return o.path;
  },
  async shotframe(o) {
    const needle = await canon(o.frame ?? 'guest-files');
    const r = await evalIn('top', `(() => { const f = [...document.querySelectorAll('iframe')].find(i => (i.src||'').includes(${JSON.stringify(needle)})); const b = f.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; })()`);
    return ops.shot({ path: o.path, clip: r });
  },
  async viewport(o) { await send('Emulation.setDeviceMetricsOverride', { width: o.w, height: o.h, deviceScaleFactor: o.scale ?? 2, mobile: false }); await sleep(600); return 'ok'; },
  async sleep(o) { await sleep(o.ms); return 'ok'; },
};

if (process.argv[2] === 'serve') {
  await connect();
  createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      try { const o = JSON.parse(body); if (!ops[o.op]) throw new Error(`unknown op ${o.op}`); const r = await ops[o.op](o); res.end(JSON.stringify({ ok: true, r })); }
      catch (e) { res.statusCode = 200; res.end(JSON.stringify({ ok: false, error: String(e.message ?? e) })); }
    });
  }).listen(PORT, '127.0.0.1', () => console.log(`driver on ${PORT}`));
}
