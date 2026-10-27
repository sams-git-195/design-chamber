// Builds the document an artboard frame loads (docs/SPEC.md §4.1, §8.2): the service-bundled
// HTML with the bridge injected as the first child of `<head>`, wrapped in a `blob:` URL.
//
// Why blob and not srcdoc: a srcdoc document's base URL is our guest package path, so any
// relative URL the bundler did not inline would hit our own package (`'self'` is allowed for
// scripts); a blob document's relative URLs fail closed. The frame that loads it must be
// `sandbox="allow-scripts"` only — never with `allow-same-origin` (see `ARTBOARD_SANDBOX`).

import { BRIDGE_PLACEHOLDER, type BridgeInit, type BridgeMode } from '../shared/bridge-protocol.ts';

/** The only sandbox value an artboard frame may carry. */
export const ARTBOARD_SANDBOX = 'allow-scripts';

/** The built bridge, or '' outside the panel bundle (unit tests pass their own). */
export const bundledBridge = (): string => (typeof __DC_BRIDGE__ === 'string' ? __DC_BRIDGE__ : '');

/** Random per document load; the bridge echoes it so a replaced document's messages are ignored. */
export const newNonce = (): string => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
};

export type FrameInit = { artboardId: string; file: string; mode: BridgeMode; scroll?: { x: number; y: number }; nonce?: string };

export const bridgeInitOf = (init: FrameInit): BridgeInit => ({
  artboardId: init.artboardId,
  file: init.file,
  mode: init.mode,
  scroll: init.scroll ?? { x: 0, y: 0 },
  nonce: init.nonce ?? newNonce(),
});

/** JSON that is safe inside a `<script>` element: no `<` at all, so no `</script` or `<!--`. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

export const bridgeScriptTag = (init: BridgeInit, bridge: string): string => {
  if (/<\/script/i.test(bridge)) throw new Error('Design Chamber: the bridge script contains "</script" and cannot be injected.');
  return `<script data-dc-bridge>window.__DC=${scriptJson(init)};\n${bridge}\n</script>`;
};

const HEAD_OPEN = /<head(?=[\s>/])[^>]*>/i;
const HTML_OPEN = /<html(?=[\s>/])[^>]*>/i;
const BODY_OPEN = /<body(?=[\s>/])/i;
const DOCTYPE = /^\s*<!doctype[^>]*>/i;

/**
 * Inserts the bridge before any design script, so the bridge is installed first: in place of
 * the service's `BRIDGE_PLACEHOLDER` (which render mode puts at the start of `<head>`), else
 * right after the opening `<head>` tag. Without a `<head>` (agent HTML is often loose) one is
 * created after `<html>`, or after the doctype, or at the very start.
 */
export const injectBridge = (html: string, init: BridgeInit, bridge: string): string => {
  const tag = bridgeScriptTag(init, bridge);
  const placeholder = html.indexOf(BRIDGE_PLACEHOLDER);
  if (placeholder !== -1) return `${html.slice(0, placeholder)}${tag}${html.slice(placeholder + BRIDGE_PLACEHOLDER.length)}`;
  const head = HEAD_OPEN.exec(html);
  const body = BODY_OPEN.exec(html);
  // A `<head>` after `<body>` is design content (a string, a template), not the document head.
  if (head && (!body || head.index < body.index)) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${tag}${html.slice(at)}`;
  }
  const htmlOpen = HTML_OPEN.exec(html);
  if (htmlOpen && (!body || htmlOpen.index < body.index)) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
  }
  const doctype = DOCTYPE.exec(html);
  const at = doctype ? doctype[0].length : 0;
  return `${html.slice(0, at)}<head>${tag}</head>${html.slice(at)}`;
};

export type FrameDocument = { url: string; init: BridgeInit; revoke: () => void };

/** The blob URL for an artboard `<iframe src>`. Call `revoke()` when the frame unloads or is replaced. */
export const createFrameDocument = (html: string, init: FrameInit, bridge: string = bundledBridge()): FrameDocument => {
  const bridgeInit = bridgeInitOf(init);
  const blob = new Blob([injectBridge(html, bridgeInit, bridge)], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  let revoked = false;
  return {
    url,
    init: bridgeInit,
    revoke: () => {
      if (revoked) return;
      revoked = true;
      URL.revokeObjectURL(url);
    },
  };
};
