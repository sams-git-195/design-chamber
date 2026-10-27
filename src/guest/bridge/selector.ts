// Element selector generation for comment anchors (docs/SPEC.md §8.3). Pure over a minimal
// element interface, so it runs in the design frame (real DOM) and in unit tests (fake DOM).
//
// Order: `#id` if unique → `[data-testid|data-screen|data-dc-id="…"]` if unique → a chain of
// `tag.stable-class:nth-of-type(k)` segments joined by ` > `, at most SELECTOR_DEPTH_MAX levels,
// stopping early at a unique ancestor id. Every candidate is verified with querySelectorAll.

import { ANCHOR_SELECTOR_MAX, SELECTOR_DEPTH_MAX } from '../../shared/limits.ts';

/** The part of `Element` selector generation reads. A DOM `Element` satisfies it. */
export interface SelectorElement {
  readonly tagName: string;
  readonly id: string;
  readonly classList: ArrayLike<string>;
  readonly parentElement: SelectorElement | null;
  readonly children: ArrayLike<SelectorElement>;
  getAttribute(name: string): string | null;
}

/** A DOM `Document` or `Element` satisfies it. */
export interface SelectorRoot {
  querySelectorAll(selector: string): ArrayLike<SelectorElement>;
}

/** Attributes authors put on purpose; preferred over structure. */
export const TEST_ATTRIBUTES = ['data-testid', 'data-screen', 'data-dc-id'] as const;

/** State classes that come and go with interaction; never part of a selector. */
const UNSTABLE_CLASS = /^(is-|has-|js-|active|hover|focus)/;
/** Classes used as-is; anything else (Tailwind `md:p-4`, escapes) is skipped rather than escaped. */
const PLAIN_IDENT = /^-?[A-Za-z_][A-Za-z0-9_-]*$/;
const CLASSES_PER_SEGMENT = 3;

/** HTML tag names come upper-case; SVG/MathML keep their case (`foreignObject`). */
export const tagNameOf = (element: SelectorElement): string =>
  element.tagName === element.tagName.toUpperCase() ? element.tagName.toLowerCase() : element.tagName;

/** A CSS string literal body for `[attr="…"]`. */
export const cssString = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ').replace(/\r/g, '\\d ').replace(/\f/g, '\\c ');

const idSelector = (id: string): string | null => {
  if (id === '') return null;
  return PLAIN_IDENT.test(id) ? `#${id}` : `[id="${cssString(id)}"]`;
};

const queryAll = (root: SelectorRoot, selector: string): ArrayLike<SelectorElement> | null => {
  try {
    return root.querySelectorAll(selector);
  } catch {
    // An invalid selector (exotic tag or attribute) is "not usable", never fatal.
    return null;
  }
};

export const isUniqueMatch = (root: SelectorRoot, selector: string, element: SelectorElement): boolean => {
  const found = queryAll(root, selector);
  return found !== null && found.length === 1 && found[0] === element;
};

const stableClasses = (element: SelectorElement): string[] => {
  const out: string[] = [];
  for (let index = 0; index < element.classList.length && out.length < CLASSES_PER_SEGMENT; index += 1) {
    const name = element.classList[index];
    if (name !== undefined && PLAIN_IDENT.test(name) && !UNSTABLE_CLASS.test(name)) out.push(name);
  }
  return out;
};

/** `:nth-of-type(k)` position among same-tag siblings, or null when the tag is alone. */
const nthOfType = (element: SelectorElement): number | null => {
  const parent = element.parentElement;
  if (!parent) return null;
  let position = 0;
  let count = 0;
  for (let index = 0; index < parent.children.length; index += 1) {
    const sibling = parent.children[index];
    if (!sibling || sibling.tagName !== element.tagName) continue;
    count += 1;
    if (sibling === element) position = count;
  }
  return count > 1 ? position : null;
};

export const segmentOf = (element: SelectorElement): string => {
  const tag = tagNameOf(element);
  if (tag === 'html' || tag === 'body') return tag;
  const classes = stableClasses(element).map((name) => `.${name}`).join('');
  const nth = nthOfType(element);
  return `${tag}${classes}${nth === null ? '' : `:nth-of-type(${nth})`}`;
};

const capLength = (parts: string[]): string => {
  const kept = [...parts];
  while (kept.join(' > ').length > ANCHOR_SELECTOR_MAX && kept.length > 1) kept.shift();
  return kept.join(' > ').slice(0, ANCHOR_SELECTOR_MAX);
};

/** The selector stored on a comment anchor. Unique when the document allows; best effort otherwise. */
export const buildSelector = (element: SelectorElement, root: SelectorRoot): string => {
  const tag = tagNameOf(element);
  if (tag === 'html' || tag === 'body' || tag === 'head') return tag;

  const own = idSelector(element.id);
  if (own && isUniqueMatch(root, own, element)) return own;

  for (const attribute of TEST_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value === null || value === '') continue;
    const selector = `[${attribute}="${cssString(value)}"]`;
    if (isUniqueMatch(root, selector, element)) return selector;
  }

  const parts: string[] = [];
  let current: SelectorElement | null = element;
  for (let depth = 0; current && depth < SELECTOR_DEPTH_MAX; depth += 1) {
    parts.unshift(segmentOf(current));
    const chain = parts.join(' > ');
    if (isUniqueMatch(root, chain, element)) return capLength(parts);
    const parent: SelectorElement | null = current.parentElement;
    if (!parent) break;
    const parentId = idSelector(parent.id);
    if (parentId && isUniqueMatch(root, parentId, parent)) {
      const anchored = [parentId, ...parts];
      if (isUniqueMatch(root, anchored.join(' > '), element)) return capLength(anchored);
    }
    current = parent;
  }
  return capLength(parts);
};
