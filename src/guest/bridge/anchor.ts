// Anchor capture and re-resolution inside the design frame (docs/SPEC.md §8.3). Pure over the
// same minimal element interface as `selector.ts`.
//
// Resolution: the stored selector still matches an element with the stored tag → `exact`;
// else a same-tag element whose normalised text starts with the stored text (≥ 12 chars) →
// `found, exact:false` ("moved — matched by text"); else not found → the pin is detached.

import { ANCHOR_HTML_MAX, ANCHOR_TEXT_MATCH_MIN, ANCHOR_TEXT_MAX } from '../../shared/limits.ts';
import type { AnchorQuery } from '../../shared/bridge-protocol.ts';
import { tagNameOf, type SelectorElement, type SelectorRoot } from './selector.ts';

export interface AnchorElement extends SelectorElement {
  readonly textContent: string | null;
  readonly attributes: ArrayLike<{ readonly name: string; readonly value: string }>;
  readonly parentElement: AnchorElement | null;
  readonly children: ArrayLike<AnchorElement>;
}

export interface AnchorRoot<E extends AnchorElement = AnchorElement> extends SelectorRoot {
  querySelectorAll(selector: string): ArrayLike<E>;
}

/** Candidates scanned by the text fallback; bounds work on huge documents. */
const TEXT_SCAN_MAX = 5000;
const SIMPLE_TAG = /^[A-Za-z][A-Za-z0-9-]*$/;

export const normalizeText = (text: string): string => text.replace(/\s+/g, ' ').trim();

export const elementText = (element: AnchorElement): string => normalizeText(element.textContent ?? '').slice(0, ANCHOR_TEXT_MAX);

const attributeValue = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The element's opening tag (`<h1 class="hero-title">`), cut to ANCHOR_HTML_MAX with `…>`. */
export const openingTag = (element: AnchorElement): string => {
  let tag = `<${tagNameOf(element)}`;
  for (let index = 0; index < element.attributes.length; index += 1) {
    const attribute = element.attributes[index];
    if (!attribute) continue;
    tag += attribute.value === '' ? ` ${attribute.name}` : ` ${attribute.name}="${attributeValue(attribute.value)}"`;
  }
  tag += '>';
  return tag.length <= ANCHOR_HTML_MAX ? tag : `${tag.slice(0, ANCHOR_HTML_MAX - 2)}…>`;
};

/** Tag name stored in an anchor's `html` snippet, lower-cased; null when unreadable. */
export const tagOfSnippet = (html: string): string | null => {
  const match = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.trim());
  return match?.[1] ? match[1].toLowerCase() : null;
};

const sameTag = (element: AnchorElement, tag: string | null): boolean => tag === null || tagNameOf(element).toLowerCase() === tag;

const queryAll = <E extends AnchorElement>(root: AnchorRoot<E>, selector: string): ArrayLike<E> => {
  try {
    return root.querySelectorAll(selector);
  } catch {
    // A stored selector the browser can no longer parse means "no exact match".
    return [];
  }
};

export type AnchorMatch<E extends AnchorElement = AnchorElement> = { found: boolean; exact: boolean; element: E | null };

export const resolveAnchor = <E extends AnchorElement>(root: AnchorRoot<E>, query: Pick<AnchorQuery, 'selector' | 'text' | 'html'>): AnchorMatch<E> => {
  const notFound: AnchorMatch<E> = { found: false, exact: false, element: null };
  const tag = tagOfSnippet(query.html);

  if (query.selector !== '') {
    const matches = queryAll(root, query.selector);
    for (let index = 0; index < matches.length; index += 1) {
      const element = matches[index];
      if (element && sameTag(element, tag)) return { found: true, exact: true, element };
    }
  }

  const wanted = normalizeText(query.text);
  if (wanted.length < ANCHOR_TEXT_MATCH_MIN) return notFound;
  const candidates = queryAll(root, tag !== null && SIMPLE_TAG.test(tag) ? tag : '*');
  let best: E | null = null;
  let bestLength = Infinity;
  for (let index = 0; index < candidates.length && index < TEXT_SCAN_MAX; index += 1) {
    const element = candidates[index];
    if (!element || !sameTag(element, tag)) continue;
    const text = normalizeText(element.textContent ?? '');
    // The innermost match wins: an ancestor comes first in document order with text at least as long.
    if (text.startsWith(wanted) && text.length <= bestLength) {
      best = element;
      bestLength = text.length;
    }
  }
  return best ? { found: true, exact: false, element: best } : notFound;
};
