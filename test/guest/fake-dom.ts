// A minimal element tree + selector engine for selector/anchor unit tests. Supports exactly
// what `selector.ts` emits and `anchor.ts` asks: compound `tag#id.class[attr="v"]:nth-of-type(n)`,
// `*`, and the child combinator ` > `. Anything else throws, like an invalid DOM selector.

import type { AnchorElement } from '../../src/guest/bridge/anchor.ts';

export class FakeElement implements AnchorElement {
  readonly tagName: string;
  parentElement: FakeElement | null = null;
  readonly children: FakeElement[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly nodes: (FakeElement | string)[] = [];

  constructor(tag: string, attrs: Record<string, string> = {}, content: (FakeElement | string)[] = []) {
    this.tagName = tag.toUpperCase();
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
    for (const node of content) this.append(node);
  }

  append(node: FakeElement | string): void {
    this.nodes.push(node);
    if (typeof node !== 'string') {
      node.parentElement = this;
      this.children.push(node);
    }
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.children.splice(parent.children.indexOf(this), 1);
    const at = parent.nodes.indexOf(this);
    if (at >= 0) parent.nodes.splice(at, 1);
    this.parentElement = null;
  }

  get id(): string {
    return this.attrs.get('id') ?? '';
  }

  get classList(): string[] {
    return (this.attrs.get('class') ?? '').split(/\s+/).filter(Boolean);
  }

  get attributes(): { name: string; value: string }[] {
    return [...this.attrs].map(([name, value]) => ({ name, value }));
  }

  get textContent(): string {
    return this.nodes.map((node) => (typeof node === 'string' ? node : node.textContent)).join('');
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

export const h = (tag: string, attrs: Record<string, string> = {}, ...content: (FakeElement | string)[]): FakeElement =>
  new FakeElement(tag, attrs, content);

type Compound = { tag: string | null; id: string | null; classes: string[]; attrs: [string, string][]; nth: number | null };

const parseCompound = (text: string): Compound => {
  const out: Compound = { tag: null, id: null, classes: [], attrs: [], nth: null };
  let rest = text;
  const tag = /^([A-Za-z][A-Za-z0-9-]*|\*)/.exec(rest);
  if (tag?.[1]) {
    out.tag = tag[1] === '*' ? null : tag[1].toLowerCase();
    rest = rest.slice(tag[0].length);
  }
  while (rest.length > 0) {
    let match: RegExpExecArray | null;
    if ((match = /^#(-?[A-Za-z_][A-Za-z0-9_-]*)/.exec(rest))) out.id = match[1] ?? null;
    else if ((match = /^\.(-?[A-Za-z_][A-Za-z0-9_-]*)/.exec(rest))) out.classes.push(match[1] ?? '');
    else if ((match = /^\[([a-z-]+)="((?:[^"\\]|\\.)*)"\]/.exec(rest))) out.attrs.push([match[1] ?? '', (match[2] ?? '').replace(/\\(.)/g, '$1')]);
    else if ((match = /^:nth-of-type\((\d+)\)/.exec(rest))) out.nth = Number(match[1]);
    else throw new SyntaxError(`fake-dom: unsupported selector part "${rest}"`);
    rest = rest.slice(match[0].length);
  }
  return out;
};

const nthOfType = (element: FakeElement): number => {
  const siblings = element.parentElement?.children.filter((child) => child.tagName === element.tagName) ?? [element];
  return siblings.indexOf(element) + 1;
};

const matchesCompound = (element: FakeElement, compound: Compound): boolean =>
  (compound.tag === null || element.tagName.toLowerCase() === compound.tag) &&
  (compound.id === null || element.id === compound.id) &&
  compound.classes.every((name) => element.classList.includes(name)) &&
  compound.attrs.every(([name, value]) => element.getAttribute(name) === value) &&
  (compound.nth === null || nthOfType(element) === compound.nth);

export const parseSelector = (selector: string): Compound[] => {
  const parts = selector.split(' > ').map((part) => part.trim());
  if (parts.some((part) => part === '')) throw new SyntaxError(`fake-dom: bad selector "${selector}"`);
  return parts.map(parseCompound);
};

const matches = (element: FakeElement, chain: Compound[]): boolean => {
  let current: FakeElement | null = element;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const compound = chain[index];
    if (!current || !compound || !matchesCompound(current, compound)) return false;
    current = current.parentElement;
  }
  return true;
};

export class FakeDocument {
  readonly documentElement: FakeElement;

  constructor(documentElement: FakeElement) {
    this.documentElement = documentElement;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const chain = parseSelector(selector);
    return [this.documentElement, ...this.documentElement.descendants()].filter((element) => matches(element, chain));
  }
}

export const fakeDocument = (body: FakeElement): FakeDocument => new FakeDocument(h('html', {}, h('head'), body));
