// frame-doc (bridge injection), frame-channel (message validation) and anchoring (pins).
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { anchorFromHit, anchorStatesOf, commentsForArtboard, docToWall, isInFrameView, placePins, trackPins } from '../../src/guest/anchoring.ts';
import { acceptFrameMessage, createFrameChannel, type MessageSourceLike } from '../../src/guest/frame-channel.ts';
import { ARTBOARD_SANDBOX, bridgeInitOf, createFrameDocument, injectBridge, newNonce } from '../../src/guest/frame-doc.ts';
import { injectBridgePlaceholder } from '../../src/service/bundle.ts';
import { BRIDGE_PLACEHOLDER, type BridgeInit } from '../../src/shared/bridge-protocol.ts';
import type { Comment } from '../../src/shared/types.ts';

const INIT: BridgeInit = { artboardId: 'home@laptop', file: 'screens/home.html', mode: 'edit', scroll: { x: 0, y: 0 }, nonce: 'n0nce' };
const BRIDGE = '/*bridge*/console.debug("bridge")';

// ---- frame-doc ----

test('injectBridge puts the bridge first in <head>, creating <head> when absent', () => {
  const withHead = injectBridge('<!doctype html><html lang="en"><HEAD data-x="1"><script>window.mine=1</script></head><body>x</body></html>', INIT, BRIDGE);
  assert.match(withHead, /^<!doctype html><html lang="en"><HEAD data-x="1"><script data-dc-bridge>window\.__DC=\{.*?\};\n\/\*bridge\*\/.*?<\/script><script>window\.mine=1/s);

  const noHead = injectBridge('<!DOCTYPE html><html><body><h1>Hi</h1></body></html>', INIT, BRIDGE);
  assert.match(noHead, /^<!DOCTYPE html><html><head><script data-dc-bridge>.*<\/script><\/head><body>/s);

  const fragment = injectBridge('<h1>Just a fragment</h1>', INIT, BRIDGE);
  assert.match(fragment, /^<head><script data-dc-bridge>.*<\/script><\/head><h1>/s);

  const doctypeOnly = injectBridge('<!doctype html>\n<h1>x</h1>', INIT, BRIDGE);
  assert.match(doctypeOnly, /^<!doctype html><head><script data-dc-bridge>/);

  // <header> is not <head>, and a "<head>" inside the body is content.
  const header = injectBridge('<html><body><header>top</header><pre>&lt;head&gt;</pre><template><head></head></template></body></html>', INIT, BRIDGE);
  assert.match(header, /^<html><head><script data-dc-bridge>/);
});

test('injectBridge replaces the service render placeholder (the shared constant), once and in place', () => {
  // The service's render output for documents with and without a <head> (bundle.ts, §9.5).
  for (const source of ['<!doctype html><html><head><title>t</title></head><body>x</body></html>', '<html><body>x</body></html>', '<p>fragment</p>']) {
    const rendered = injectBridgePlaceholder(source);
    assert.ok(rendered.includes(BRIDGE_PLACEHOLDER));
    // `$&` would be expanded by String.replace with a string pattern; the bridge text must land verbatim.
    const html = injectBridge(rendered, INIT, `${BRIDGE};var s="$&$'"`);
    assert.ok(!html.includes(BRIDGE_PLACEHOLDER), 'no placeholder survives');
    assert.equal(html.split('<script data-dc-bridge>').length, 2, 'exactly one bridge');
    assert.ok(html.includes('var s="$&$\'"'));
    assert.equal(html.replace(/<script data-dc-bridge>[\s\S]*?<\/script>/, BRIDGE_PLACEHOLDER), rendered, 'the bridge sits where the placeholder was');
  }
});

test('bridge init JSON cannot break out of its <script>; a bridge containing </script is refused', () => {
  const hostile = { ...INIT, file: 'screens/</script><script>alert(1)</script>.html' };
  const html = injectBridge('<html><head></head></html>', hostile, BRIDGE);
  assert.equal(html.match(/<\/script/gi)?.length, 1, 'only the bridge tag closes a script');
  assert.ok(html.includes('\\u003c/script>'));
  assert.throws(() => injectBridge('<html></html>', INIT, 'var a="</script>"'), /cannot be injected/);
});

test('createFrameDocument returns a revocable blob URL; nonce is random hex', async () => {
  const doc = createFrameDocument('<html><head></head><body>hi</body></html>', { artboardId: 'artifact@laptop', file: 'index.html', mode: 'play' }, BRIDGE);
  assert.match(doc.url, /^blob:/);
  assert.match(doc.init.nonce, /^[0-9a-f]{24}$/);
  assert.deepEqual(doc.init.scroll, { x: 0, y: 0 });
  doc.revoke();
  doc.revoke();
  assert.notEqual(newNonce(), newNonce());
  assert.equal(ARTBOARD_SANDBOX, 'allow-scripts');
  assert.equal(bridgeInitOf({ ...INIT }).nonce, INIT.nonce);
});

// ---- frame-channel: message validation ----

const frameWindow = { postMessage: () => undefined };
const ready = { dc: 1, type: 'ready', artboardId: INIT.artboardId, nonce: INIT.nonce, docWidth: 1280, docHeight: 2000, title: 'Home' };

test('acceptFrameMessage: only this frame, a valid shape, the right artboard and nonce', () => {
  const identity = { artboardId: INIT.artboardId, nonce: INIT.nonce };
  assert.deepEqual(acceptFrameMessage({ source: frameWindow, data: ready }, frameWindow, identity), ready);
  // Foreign source: another frame, the page itself, or null.
  assert.equal(acceptFrameMessage({ source: { postMessage: () => undefined }, data: ready }, frameWindow, identity), null);
  assert.equal(acceptFrameMessage({ source: null, data: ready }, frameWindow, identity), null);
  assert.equal(acceptFrameMessage({ source: null, data: ready }, null, identity), null);
  // Stale document (old nonce) or another artboard's message.
  assert.equal(acceptFrameMessage({ source: frameWindow, data: { ...ready, nonce: 'old' } }, frameWindow, identity), null);
  assert.equal(acceptFrameMessage({ source: frameWindow, data: { ...ready, artboardId: 'home@phone' } }, frameWindow, identity), null);
  // Bad shapes.
  for (const data of [null, 'ready', { ...ready, dc: 2 }, { ...ready, docWidth: '1280' }, { ...ready, type: 'eval' }, { ...ready, type: 'open-external', url: 'javascript:alert(1)' }]) {
    assert.equal(acceptFrameMessage({ source: frameWindow, data }, frameWindow, identity), null, JSON.stringify(data));
  }
});

const fakeWindow = (): MessageSourceLike & { dispatch(event: { source: unknown; data: unknown }): void; count(): number } => {
  const listeners = new Set<(event: MessageEvent) => void>();
  return {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    // Safe: the channel reads only `source` and `data`.
    dispatch: (event) => {
      for (const listener of listeners) listener(event as MessageEvent);
    },
    count: () => listeners.size,
  };
};

test('createFrameChannel: acks ready, envelopes outgoing messages, drops foreign ones, disposes', () => {
  const sent: unknown[] = [];
  const contentWindow = { postMessage: (message: unknown, origin: string) => sent.push([message, origin]) };
  const win = fakeWindow();
  const channel = createFrameChannel({ artboardId: INIT.artboardId, nonce: INIT.nonce, frame: { contentWindow }, window: win });
  const received: string[] = [];
  channel.subscribe((message) => received.push(message.type));

  win.dispatch({ source: contentWindow, data: ready });
  win.dispatch({ source: frameWindow, data: ready });
  win.dispatch({ source: contentWindow, data: { ...ready, type: 'scroll', x: 1, y: 'two' } });
  assert.deepEqual(received, ['ready']);
  assert.deepEqual(sent, [[{ type: 'init-ack', dc: 1, artboardId: INIT.artboardId, nonce: INIT.nonce }, '*']]);

  channel.send({ type: 'hit-test', x: 3, y: 4 });
  assert.deepEqual(sent[1], [{ type: 'hit-test', x: 3, y: 4, dc: 1, artboardId: INIT.artboardId, nonce: INIT.nonce }, '*']);

  channel.dispose();
  assert.equal(win.count(), 0);
  channel.send({ type: 'scroll-by', dx: 1, dy: 1 });
  assert.equal(sent.length, 2);
});

// ---- anchoring ----

const comment = (id: string, rect = { x: 100, y: 200, w: 400, h: 50 }, screen: string | null = 'home', viewport = 'laptop'): Comment => ({
  id,
  screen,
  viewport,
  anchor: { selector: 'main > h1', text: 'Fresh roasts every Monday', html: '<h1>', rect, point: { x: 0.25, y: 0.5 } },
  body: 'Shorter',
  status: 'open',
  created: '2026-10-26T18:00:00.000Z',
  sentAt: null,
  sentVersion: null,
});

test('placePins: pending before answers, exact/moved at the live rect, detached at the stored rect', () => {
  const comments = [comment('c_aaaa'), comment('c_bbbb'), comment('c_cccc'), comment('c_dddd')];
  assert.deepEqual(
    placePins(comments, null).map((pin) => pin.state),
    ['pending', 'pending', 'pending', 'pending'],
  );
  const pins = placePins(comments, [
    { id: 'c_aaaa', found: true, exact: true, rect: { x: 0, y: 0, w: 100, h: 10 } },
    { id: 'c_bbbb', found: true, exact: false, rect: { x: 10, y: 1000, w: 200, h: 20 } },
    { id: 'c_cccc', found: false, exact: false, rect: null },
  ]);
  assert.deepEqual(
    pins.map((pin) => [pin.commentId, pin.state, pin.point]),
    [
      ['c_aaaa', 'exact', { x: 25, y: 5 }],
      ['c_bbbb', 'moved', { x: 60, y: 1010 }],
      ['c_cccc', 'detached', { x: 200, y: 225 }],
      ['c_dddd', 'pending', { x: 200, y: 225 }],
    ],
  );
  // What send-comments passes to the prompt route: answered pins only.
  assert.deepEqual(anchorStatesOf(pins), { c_aaaa: 'exact', c_bbbb: 'moved', c_cccc: 'detached' });
  assert.deepEqual(anchorStatesOf(placePins(comments, null)), {});
});

test('coordinates: doc → frame → wall, visibility, and anchors from a click', () => {
  const scroll = { x: 0, y: 300 };
  assert.deepEqual(docToWall({ x: 25, y: 305 }, scroll, { x: 1000, y: 28, width: 1280, height: 800 }), { x: 1025, y: 33 });
  assert.equal(isInFrameView({ x: 25, y: 305 }, scroll, { width: 1280, height: 800 }), true);
  assert.equal(isInFrameView({ x: 25, y: 200 }, scroll, { width: 1280, height: 800 }), false);
  const anchor = anchorFromHit(
    { selector: 'main > h1', text: 'Hi', html: '<h1>', rect: { x: 100, y: 400, w: 200, h: 100 }, tag: 'h1' },
    { x: 150, y: 175 },
    scroll,
  );
  assert.deepEqual(anchor.point, { x: 0.25, y: 0.75 });
  assert.equal(anchorFromHit({ selector: 'i', text: '', html: '<i>', rect: { x: 0, y: 0, w: 0, h: 0 }, tag: 'i' }, { x: 5, y: 5 }, { x: 0, y: 0 }).point.x, 0.5);
  assert.deepEqual(
    commentsForArtboard([comment('c_1', undefined, 'home', 'laptop'), comment('c_2', undefined, 'home', 'phone'), comment('c_3', undefined, null, 'laptop')], 'home', 'laptop').map((c) => c.id),
    ['c_1'],
  );
});

test('trackPins asks on ready and size, follows scroll, ignores answers to an older question', () => {
  const sent: { type: string; anchors?: { id: string }[] }[] = [];
  let push: (message: never) => void = () => undefined;
  const channel = {
    identity: { artboardId: 'a', nonce: 'n' },
    send: (body: { type: string }) => sent.push(body),
    subscribe: (listener: (message: never) => void) => {
      push = listener;
      return () => undefined;
    },
    dispose: () => undefined,
  };
  const env = { dc: 1, artboardId: 'a', nonce: 'n' } as const;
  // Safe: a structural stand-in for FrameChannel; trackPins uses send/subscribe only.
  const tracker = trackPins(channel as never, [comment('c_aaaa')]);
  const seen: string[][] = [];
  tracker.subscribe((pins) => seen.push(pins.map((pin) => pin.state)));

  assert.equal(sent.length, 0, 'nothing asked before ready');
  push({ ...env, type: 'ready', docWidth: 1, docHeight: 1, title: '' } as never);
  assert.deepEqual(sent.map((m) => m.anchors?.map((a) => a.id)), [['c_aaaa']]);

  tracker.setComments([comment('c_aaaa'), comment('c_bbbb')]);
  push({ ...env, type: 'anchors', results: [{ id: 'c_aaaa', found: true, exact: true, rect: { x: 0, y: 0, w: 1, h: 1 } }] } as never);
  assert.deepEqual(seen.at(-1), ['pending', 'pending'], 'stale answer ignored');
  push({
    ...env,
    type: 'anchors',
    results: [
      { id: 'c_aaaa', found: true, exact: true, rect: { x: 0, y: 0, w: 1, h: 1 } },
      { id: 'c_bbbb', found: false, exact: false, rect: null },
    ],
  } as never);
  assert.deepEqual(seen.at(-1), ['exact', 'detached']);

  push({ ...env, type: 'scroll', x: 0, y: 120 } as never);
  assert.deepEqual(tracker.scroll(), { x: 0, y: 120 });
  push({ ...env, type: 'size', docWidth: 1, docHeight: 2 } as never);
  assert.equal(sent.length, 3, 'size change re-asks');
  tracker.dispose();
});
