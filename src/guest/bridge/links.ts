// Play-mode link classification (docs/SPEC.md §8.3). Pure: the bridge calls it on every
// intercepted click and acts on the answer; nothing here navigates.
//
// Relative links resolve against a virtual `https://design.invalid/<file>` so `../`, `./` and
// query strings behave like a browser would, without ever pointing at a real origin.

import { BRIDGE_URL_MAX, SCREEN_ID_PATTERN } from '../../shared/limits.ts';

export const VIRTUAL_ORIGIN = 'https://design.invalid';

export type LinkAction =
  /** Scroll to an element of this document (`#pricing`); `id` '' = top. */
  | { kind: 'fragment'; id: string }
  /** Another file of the design (`screens/checkout.html`); the page decides whether it is a screen. */
  | { kind: 'navigate'; href: string; hash: string }
  /** A web page; the page asks the user before `openUrl`. */
  | { kind: 'external'; url: string }
  /** Anything else (`mailto:`, `javascript:`, assets, empty): prevented, nothing happens. */
  | { kind: 'blocked'; reason: string };

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

export const classifyLink = (rawHref: string, file: string): LinkAction => {
  const href = rawHref.trim();
  if (href === '') return { kind: 'blocked', reason: 'empty link' };
  if (href.startsWith('#')) return { kind: 'fragment', id: decode(href.slice(1)) };

  let url: URL;
  try {
    url = new URL(href, `${VIRTUAL_ORIGIN}/${file}`);
  } catch {
    return { kind: 'blocked', reason: 'malformed link' };
  }

  if (url.origin === VIRTUAL_ORIGIN) {
    const target = decode(url.pathname.replace(/^\/+/, ''));
    if (target === file || target === '') {
      return url.hash ? { kind: 'fragment', id: decode(url.hash.slice(1)) } : { kind: 'blocked', reason: 'same page' };
    }
    if (!/\.html?$/i.test(target)) return { kind: 'blocked', reason: 'not a page of this design' };
    if (target.length > BRIDGE_URL_MAX || url.hash.length > BRIDGE_URL_MAX) return { kind: 'blocked', reason: 'link too long' };
    return { kind: 'navigate', href: target, hash: url.hash };
  }

  if ((url.protocol === 'https:' || url.protocol === 'http:') && url.href.length <= BRIDGE_URL_MAX) {
    return { kind: 'external', url: url.href };
  }
  return { kind: 'blocked', reason: `${url.protocol} links do not open from a design` };
};

/** `[data-dc-goto="<screenId>"]` → that screen's file. */
export const classifyGoto = (screenId: string): LinkAction =>
  SCREEN_ID_PATTERN.test(screenId)
    ? { kind: 'navigate', href: `screens/${screenId}.html`, hash: '' }
    : { kind: 'blocked', reason: 'unknown screen id' };
