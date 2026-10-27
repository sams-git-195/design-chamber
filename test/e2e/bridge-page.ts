// Browser-side scenario for test/e2e/bridge.test.ts. Bundled with esbuild (IIFE, with the real
// bridge as `__DC_BRIDGE__`) and run as the guest page inside a sandboxed, CSP'd frame — the
// same setup OpenChamber gives our panel. It loads a design through the real frame-doc +
// frame-channel + anchoring code, drives it, and posts every observation to `parent`.

import { trackPins } from '../../src/guest/anchoring.ts';
import { createFrameChannel } from '../../src/guest/frame-channel.ts';
import { ARTBOARD_SANDBOX, createFrameDocument } from '../../src/guest/frame-doc.ts';
import type { FrameToPageMessage } from '../../src/shared/bridge-protocol.ts';
import type { Comment } from '../../src/shared/types.ts';

// The design: no <head> (the bridge must create one), fixed geometry, links of every kind, and
// a test hook (the design's own script) that performs clicks/keys/wheel on request.
const DESIGN = `<!doctype html>
<html><body style="margin:0;font:16px/1.2 sans-serif">
<h1 class="hero-title is-active" style="position:absolute;left:50px;top:100px;width:400px;height:60px;margin:0">Fresh roasts, every other Monday</h1>
<main style="position:absolute;left:0;top:300px;width:600px">
  <section><p class="lead">This paragraph text moved somewhere else entirely</p></section>
  <a id="to-pricing" href="pricing.html#plans">Pricing</a>
  <a id="to-web" href="https://example.com/about?x=1">About</a>
  <a id="to-js" href="javascript:void(0)">JS</a>
  <a id="to-bottom" href="#bottom">Bottom</a>
  <button id="goto" data-dc-goto="checkout">Checkout</button>
  <form id="form" action="https://example.com/post"><input id="field" name="q"><button>Send</button></form>
</main>
<div id="bottom" style="position:absolute;top:2400px;height:10px;width:10px"></div>
<script>
  addEventListener('message', function (event) {
    if (event.source !== parent || !event.data || event.data.test !== 'do') return;
    var d = event.data, report = function (r) { parent.postMessage({ test: 'report', step: d.step, r: r }, '*'); };
    if (d.action === 'click') { document.querySelector(d.selector).click(); report(location.protocol); }
    if (d.action === 'submit') { document.getElementById('form').requestSubmit(); report(location.protocol); }
    if (d.action === 'key') {
      var target = d.inInput ? document.getElementById('field') : document.body;
      target.dispatchEvent(new KeyboardEvent('keydown', { key: d.key, bubbles: true, cancelable: true, ctrlKey: !!d.ctrl }));
      report(true);
    }
    if (d.action === 'wheel') {
      document.body.dispatchEvent(new WheelEvent('wheel', { deltaY: d.deltaY, deltaMode: d.deltaMode || 0, ctrlKey: !!d.ctrl, clientX: 10, clientY: 20, bubbles: true, cancelable: true }));
      report(true);
    }
    if (d.action === 'grow') { var b = document.createElement('div'); b.style.cssText = 'position:absolute;top:4000px;height:20px;width:20px'; document.body.appendChild(b); report(true); }
    if (d.action === 'self-post') { window.postMessage(d.message, '*'); setTimeout(function () { report(scrollY); }, 150); }
    if (d.action === 'forge') { parent.postMessage(d.message, '*'); report(true); }
    if (d.action === 'overlay') { var o = document.querySelector('[data-dc-overlay]'); report(o ? o.getAttribute('style') : null); }
    if (d.action === 'escape-top') { var res; try { res = Boolean(parent.parent.document); } catch (e) { res = 'denied'; } report(res); }
    if (d.action === 'state') { report({ scrollY: scrollY, title: document.title, head: document.head.firstElementChild && document.head.firstElementChild.hasAttribute('data-dc-bridge'), dc: typeof window.__DC }); }
  });
</script>
</body></html>`;

const results: Record<string, unknown> = { started: true };
const finish = (): void => parent.postMessage({ e2e: true, results }, '*');

const run = async (): Promise<void> => {
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', ARTBOARD_SANDBOX);
  iframe.style.cssText = 'width:1280px;height:800px;border:0';
  const frameDoc = createFrameDocument(DESIGN, { artboardId: 'home@laptop', file: 'screens/home.html', mode: 'edit' });
  const nonce = frameDoc.init.nonce;
  const channel = createFrameChannel({ artboardId: 'home@laptop', nonce, frame: iframe });
  // Created before the frame loads, as the wall does, so it sees `ready`.
  const tracker = trackPins(channel, []);
  const inbox: FrameToPageMessage[] = [];
  const waiters: { test: (m: FrameToPageMessage) => boolean; resolve: (m: FrameToPageMessage | null) => void }[] = [];
  channel.subscribe((message) => {
    inbox.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.test(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  const next = <T extends FrameToPageMessage['type']>(type: T, test: (m: Extract<FrameToPageMessage, { type: T }>) => boolean = () => true, ms = 2000) =>
    new Promise<Extract<FrameToPageMessage, { type: T }> | null>((resolve) => {
      // Safe: the predicate only receives messages whose `type` matched.
      const waiter = { test: (m: FrameToPageMessage) => m.type === type && test(m as Extract<FrameToPageMessage, { type: T }>), resolve: resolve as (m: FrameToPageMessage | null) => void };
      waiters.push(waiter);
      setTimeout(() => {
        const at = waiters.indexOf(waiter);
        if (at >= 0) {
          waiters.splice(at, 1);
          resolve(null);
        }
      }, ms);
    });

  const reports = new Map<string, (value: unknown) => void>();
  addEventListener('message', (event) => {
    if (event.source !== iframe.contentWindow || !event.data || event.data.test !== 'report') return;
    reports.get(event.data.step)?.(event.data.r);
  });
  let stepNo = 0;
  const act = (action: Record<string, unknown>): Promise<unknown> => {
    stepNo += 1;
    const step = `s${stepNo}`;
    return new Promise((resolve) => {
      reports.set(step, resolve);
      iframe.contentWindow?.postMessage({ test: 'do', step, ...action }, '*');
      setTimeout(() => resolve('timeout'), 2000);
    });
  };
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const readyPromise = next('ready');
  iframe.src = frameDoc.url;
  document.body.append(iframe);
  const ready = await readyPromise;
  results.ready = ready && { docWidth: ready.docWidth, docHeight: ready.docHeight, title: ready.title };
  // A sandboxed (out-of-process) frame can reach DOM-ready before its viewport size arrives, so
  // `ready` may carry the content width alone; the bridge's ResizeObserver then sends `size`,
  // and the page keeps the latest. Record the settled size the way the page would see it.
  if (ready && ready.docWidth < 1200) {
    const settled = (m: FrameToPageMessage): boolean => m.type === 'size' && m.docWidth >= 1200;
    const size = inbox.find(settled) ?? (await next('size', settled));
    if (size && size.type === 'size') results.ready = { docWidth: size.docWidth, docHeight: size.docHeight, title: ready.title };
  }
  results.state = await act({ action: 'state' });

  // Edit mode: hit-test.
  channel.send({ type: 'hit-test', x: 250, y: 130 });
  const hit = await next('hit');
  results.hit = hit?.element ?? 'none';
  channel.send({ type: 'hit-test', x: 900, y: 50 });
  results.hitEmpty = (await next('hit', (m) => m.x === 900))?.element ?? null;

  // Anchors: exact, moved (text), detached; via the real page-side tracker.
  const selector = hit?.element?.selector ?? '';
  const comment = (id: string, anchor: Partial<Comment['anchor']>): Comment => ({
    id,
    screen: 'home',
    viewport: 'laptop',
    anchor: { selector: '', text: '', html: '<p>', rect: { x: 1, y: 2, w: 3, h: 4 }, point: { x: 0.5, y: 0.5 }, ...anchor },
    body: 'x',
    status: 'open',
    created: '2026-10-26T18:00:00.000Z',
    sentAt: null,
    sentVersion: null,
  });
  const pinsDone = new Promise<unknown>((resolve) =>
    tracker.subscribe((pins) => {
      if (pins.length === 3 && pins.every((pin) => pin.state !== 'pending')) resolve(pins);
    }),
  );
  tracker.setComments([
    comment('c_exact', { selector, text: hit?.element?.text ?? '', html: hit?.element?.html ?? '<h1>' }),
    comment('c_moved', { selector: 'main > div.gone > p', text: 'This paragraph text moved', html: '<p class="old">' }),
    comment('c_gone', { selector: '#nope', text: 'tiny', html: '<p>' }),
  ]);
  await act({ action: 'grow' });
  results.size = (await next('size', (m) => m.docHeight >= 4000)) ?? 'none';
  results.pins = await Promise.race([pinsDone, sleep(2000).then(() => 'timeout')]);

  // Scroll sync.
  channel.send({ type: 'scroll-to', x: 0, y: 500 });
  results.scrollTo = (await next('scroll', (m) => m.y === 500)) ?? 'none';
  channel.send({ type: 'scroll-by', dx: 0, dy: 100 });
  results.scrollBy = (await next('scroll', (m) => m.y === 600)) ?? 'none';
  channel.send({ type: 'resolve-anchors', anchors: [{ id: 'c_exact', selector, text: '', html: '<h1>' }] });
  results.anchorAfterScroll = (await next('anchors'))?.results[0]?.rect ?? 'none';

  // Highlight overlay.
  channel.send({ type: 'highlight', selector });
  await sleep(100);
  results.overlay = await act({ action: 'overlay' });
  channel.send({ type: 'highlight', selector: null });
  await sleep(100);
  results.overlayCleared = await act({ action: 'overlay' });

  // Wheel and keys.
  const wheel = next('wheel');
  await act({ action: 'wheel', deltaY: 3, deltaMode: 1, ctrl: true });
  results.wheel = (await wheel) ?? 'none';
  const keyEsc = next('key');
  await act({ action: 'key', key: 'Escape' });
  results.key = (await keyEsc) ?? 'none';
  const keyInput = next('key', () => true, 400);
  await act({ action: 'key', key: '+', inInput: true });
  results.keyInInput = (await keyInput) ?? 'none';

  // Play mode: links.
  channel.send({ type: 'set-mode', mode: 'play' });
  await sleep(50);
  const plainWheel = next('wheel', () => true, 400);
  await act({ action: 'wheel', deltaY: 50, ctrl: false });
  results.playPlainWheel = (await plainWheel) ?? 'none';

  const nav = next('navigate');
  results.clickPricing = await act({ action: 'click', selector: '#to-pricing' });
  results.navigate = (await nav) ?? 'none';
  const ext = next('open-external');
  await act({ action: 'click', selector: '#to-web' });
  results.external = (await ext) ?? 'none';
  const goto = next('navigate', (m) => m.href.includes('checkout'));
  await act({ action: 'click', selector: '#goto' });
  results.goto = (await goto) ?? 'none';
  const jsNav = next('navigate', () => true, 400);
  const jsExt = next('open-external', () => true, 400);
  await act({ action: 'click', selector: '#to-js' });
  results.jsLink = [(await jsNav) ?? 'none', (await jsExt) ?? 'none'];
  const fragment = next('scroll', (m) => m.y > 1000);
  await act({ action: 'click', selector: '#to-bottom' });
  results.fragment = (await fragment) ?? 'none';
  results.submit = await act({ action: 'submit' });

  // Forged and foreign messages.
  const forgedNav = next('navigate', (m) => m.href === 'forged.html', 500);
  await act({ action: 'forge', message: { dc: 1, type: 'navigate', artboardId: 'home@laptop', nonce: 'not-the-nonce', href: 'forged.html', hash: '' } });
  results.forgedNonce = (await forgedNav) ?? 'none';

  const intruder = document.createElement('iframe');
  intruder.setAttribute('sandbox', 'allow-scripts');
  const intruderHtml = `<script>parent.postMessage(${JSON.stringify({ dc: 1, type: 'navigate', artboardId: 'home@laptop', nonce, href: 'intruder.html', hash: '' })}, '*');</script>`;
  intruder.src = URL.createObjectURL(new Blob([intruderHtml], { type: 'text/html' }));
  // Positive control: the intruder's message does reach this page; only the channel drops it.
  addEventListener('message', (event) => {
    if (event.source === intruder.contentWindow && event.data?.href === 'intruder.html') results.intruderPosted = true;
  });
  const intruderNav = next('navigate', (m) => m.href === 'intruder.html', 800);
  document.body.append(intruder);
  results.foreignSource = (await intruderNav) ?? 'none';

  // The bridge only obeys its parent: a scroll-to the design posts to itself is ignored.
  results.selfPost = await act({ action: 'self-post', message: { dc: 1, type: 'scroll-to', artboardId: 'home@laptop', nonce, x: 0, y: 7 } });
  results.escapeTop = await act({ action: 'escape-top' });
  results.finalState = await act({ action: 'state' });
  results.inboxTypes = [...new Set(inbox.map((m) => m.type))].sort();
  frameDoc.revoke();
};

run().then(finish, (error: unknown) => {
  results.error = String(error instanceof Error ? error.stack : error);
  finish();
});
