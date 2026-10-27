import assert from 'node:assert/strict';
import { test } from 'node:test';

import { artboardIdOf, parseFrameMessage, parsePageMessage } from '../../src/shared/bridge-protocol.ts';

const env = { dc: 1, artboardId: 'home@laptop', nonce: 'n1' };

test('valid frame → page messages parse', () => {
  const messages = [
    { ...env, type: 'ready', docWidth: 1280, docHeight: 3000, title: 'Home' },
    { ...env, type: 'size', docWidth: 1280, docHeight: 3100 },
    { ...env, type: 'scroll', x: 0, y: 420 },
    { ...env, type: 'hit', x: 10, y: 20, element: { selector: 'main > h1', text: 'Hi', html: '<h1>', rect: { x: 0, y: 0, w: 10, h: 10 }, tag: 'h1' } },
    { ...env, type: 'hit', x: 10, y: 20, element: null },
    { ...env, type: 'anchors', results: [{ id: 'c_1', found: true, rect: { x: 1, y: 2, w: 3, h: 4 }, exact: false }, { id: 'c_2', found: false, rect: null, exact: false }] },
    { ...env, type: 'navigate', href: 'screens/checkout.html', hash: '' },
    { ...env, type: 'open-external', url: 'https://example.com/a' },
    { ...env, type: 'wheel', deltaX: 0, deltaY: -120, x: 5, y: 5, ctrl: true },
    { ...env, type: 'key', key: 'Escape', ctrl: false, meta: false, shift: false },
  ];
  for (const message of messages) assert.notEqual(parseFrameMessage(message), null, JSON.stringify(message));
});

test('malformed or foreign frame messages are rejected', () => {
  const bad: unknown[] = [
    null,
    'ready',
    { ...env, type: 'ready', docWidth: 1, docHeight: 1, title: 'x', dc: 2 },
    { ...env, type: 'ready', docWidth: Number.NaN, docHeight: 1, title: 'x' },
    { ...env, type: 'size', docWidth: -1, docHeight: 1 },
    { ...env, type: 'teleport' },
    { ...env, type: 'toString' },
    { ...env, type: 'scroll', x: 0, y: 0, artboardId: '' },
    { ...env, type: 'scroll', x: 0, y: 0, nonce: undefined },
    { ...env, type: 'open-external', url: 'javascript:alert(1)' },
    { ...env, type: 'open-external', url: 'file:///C:/Windows' },
    { ...env, type: 'navigate', href: 'a.html', hash: 'no-hash-sign' },
    { ...env, type: 'key', key: 'F5', ctrl: false, meta: false, shift: false },
    { ...env, type: 'anchors', results: 'all' },
    { ...env, type: 'hit', x: 1, y: 1, element: { selector: 's', text: 't', html: '<a>', rect: { x: 0, y: 0, w: 1, h: 1 }, tag: '' } },
    { ...env, type: 'wheel', deltaX: 0, deltaY: 1e9, x: 0, y: 0, ctrl: false },
  ];
  for (const message of bad) assert.equal(parseFrameMessage(message), null, JSON.stringify(message));
});

test('page → frame messages parse, and frame types are not accepted as page types', () => {
  assert.notEqual(parsePageMessage({ ...env, type: 'set-mode', mode: 'play' }), null);
  assert.notEqual(parsePageMessage({ ...env, type: 'highlight', selector: null }), null);
  assert.notEqual(parsePageMessage({ ...env, type: 'resolve-anchors', anchors: [{ id: 'c_1', selector: 'h1', text: 't', html: '<h1>' }] }), null);
  assert.equal(parsePageMessage({ ...env, type: 'set-mode', mode: 'admin' }), null);
  assert.equal(parsePageMessage({ ...env, type: 'ready', docWidth: 1, docHeight: 1, title: '' }), null);
  assert.equal(parseFrameMessage({ ...env, type: 'init-ack' }), null);
});

test('artboard ids combine screen (or artifact) and viewport', () => {
  assert.equal(artboardIdOf('home', 'laptop'), 'home@laptop');
  assert.equal(artboardIdOf(null, 'phone'), 'artifact@phone');
});
