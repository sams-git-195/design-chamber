// Pure bridge helpers over a fake DOM: selector generation, anchor capture/resolution, links.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { elementText, normalizeText, openingTag, resolveAnchor, tagOfSnippet } from '../../src/guest/bridge/anchor.ts';
import { classifyGoto, classifyLink } from '../../src/guest/bridge/links.ts';
import { buildSelector, cssString } from '../../src/guest/bridge/selector.ts';
import { ANCHOR_HTML_MAX, ANCHOR_TEXT_MAX } from '../../src/shared/limits.ts';
import { fakeDocument, h, type FakeDocument, type FakeElement } from './fake-dom.ts';

const uniqueFor = (doc: FakeDocument, element: FakeElement): string => {
  const selector = buildSelector(element, doc);
  const found = doc.querySelectorAll(selector);
  assert.equal(found.length, 1, `"${selector}" should match exactly one element`);
  assert.equal(found[0], element, `"${selector}" should match the element itself`);
  return selector;
};

// ---- selector.ts ----

test('selector: unique id wins; a duplicated id is not used', () => {
  const title = h('h1', { id: 'hero-title' }, 'Hi');
  const doc = fakeDocument(h('body', {}, h('main', {}, title)));
  assert.equal(uniqueFor(doc, title), '#hero-title');

  const a = h('p', { id: 'dup' }, 'a');
  const b = h('p', { id: 'dup' }, 'b');
  const twice = fakeDocument(h('body', {}, a, b));
  const selector = uniqueFor(twice, b);
  assert.ok(!selector.includes('#dup'), selector);
});

test('selector: data-testid / data-screen / data-dc-id when unique', () => {
  const plan = h('div', { 'data-testid': 'plan-regular', class: 'card' }, 'Regular');
  const doc = fakeDocument(h('body', {}, h('div', { 'data-testid': 'plan-taster', class: 'card' }, 'Taster'), plan));
  assert.equal(uniqueFor(doc, plan), '[data-testid="plan-regular"]');
  const odd = h('div', { 'data-dc-id': 'say "hi"' });
  assert.equal(uniqueFor(fakeDocument(h('body', {}, odd)), odd), '[data-dc-id="say \\"hi\\""]');
  assert.equal(cssString('a\\b"c\nd'), 'a\\\\b\\"c\\a d');
});

test('selector: stable classes kept, state classes dropped, nth-of-type for same-tag siblings', () => {
  const second = h('li', { class: 'item is-active js-toggle active hover-x focus-ring plan' }, 'Two');
  const list = h('ul', { class: 'plans' }, h('li', { class: 'item plan' }, 'One'), second, h('li', { class: 'item plan' }, 'Three'));
  const doc = fakeDocument(h('body', {}, h('main', {}, list)));
  const selector = uniqueFor(doc, second);
  assert.match(selector, /li\.item\.plan:nth-of-type\(2\)$/);
  for (const unstable of ['is-active', 'js-toggle', '.active', 'hover-x', 'focus-ring']) assert.ok(!selector.includes(unstable), `${unstable} in ${selector}`);
});

test('selector: anchors at a unique ancestor id; chain capped at 6 levels', () => {
  const target = h('span', {}, 'deep');
  const doc = fakeDocument(h('body', {}, h('section', {}, h('div', {}, h('span', {}, 'other'))), h('section', { id: 'pricing' }, h('div', {}, target))));
  assert.equal(uniqueFor(doc, target), '#pricing > div > span');

  // Nine identical nested divs: no unique path within 6 levels → best effort, ≤ 6 segments.
  const leaf = h('b', {}, 'leaf');
  let node: FakeElement = leaf;
  for (let i = 0; i < 9; i += 1) node = h('div', {}, node);
  let twin: FakeElement = h('b', {}, 'leaf');
  for (let i = 0; i < 9; i += 1) twin = h('div', {}, twin);
  const deep = fakeDocument(h('body', {}, node, twin));
  const chain = buildSelector(leaf, deep);
  assert.ok(chain.split(' > ').length <= 6, chain);
  assert.equal(buildSelector(h('body'), deep), 'body');
});

test('selector: ids and classes that are not plain identifiers are escaped or skipped', () => {
  const odd = h('div', { id: '1 two', class: 'md:p-4 card' }, 'x');
  const doc = fakeDocument(h('body', {}, odd));
  assert.equal(uniqueFor(doc, odd), '[id="1 two"]');
  const noId = h('p', { class: 'md:p-4 lead' }, 'x');
  const doc2 = fakeDocument(h('body', {}, h('p', {}, 'y'), noId));
  const selector = uniqueFor(doc2, noId);
  assert.ok(!selector.includes('md:p-4') && selector.includes('.lead'), selector);
});

// ---- anchor.ts ----

test('anchor: text is normalised and capped; opening tag escaped and capped', () => {
  const el = h('h1', { class: 'hero-title', title: 'a "quote" & more' }, '  Ship\n   faster  ', h('em', {}, 'today'));
  assert.equal(elementText(el), 'Ship faster today');
  assert.equal(openingTag(el), '<h1 class="hero-title" title="a &quot;quote&quot; &amp; more">');
  assert.equal(elementText(h('p', {}, 'x'.repeat(500))).length, ANCHOR_TEXT_MAX);
  const long = openingTag(h('div', { class: 'c'.repeat(400) }));
  assert.equal(long.length, ANCHOR_HTML_MAX);
  assert.ok(long.endsWith('…>'));
  assert.equal(tagOfSnippet('<H1 class="x">'), 'h1');
  assert.equal(tagOfSnippet('garbage'), null);
  assert.equal(normalizeText(' a \t b '), 'a b');
});

test('anchor: exact when the stored selector still matches an element with the stored tag', () => {
  const h1 = h('h1', { class: 'title' }, 'Ship faster with fewer meetings');
  const doc = fakeDocument(h('body', {}, h('main', {}, h1)));
  const query = { selector: buildSelector(h1, doc), text: elementText(h1), html: openingTag(h1) };
  const match = resolveAnchor(doc, query);
  assert.deepEqual([match.found, match.exact, match.element], [true, true, h1]);
});

test('anchor: after an edit the text fallback re-matches (exact:false); short text detaches', () => {
  const before = h('h2', { class: 'lead' }, 'Fresh roasts, every other Monday');
  const doc = fakeDocument(h('body', {}, h('main', {}, h('section', {}, before))));
  const stored = { selector: buildSelector(before, doc), text: elementText(before), html: openingTag(before) };

  // The agent restructured the page: new wrapper, new class, text extended.
  const after = h('h2', { class: 'headline' }, 'Fresh roasts, every other Monday — now weekly too');
  const edited = fakeDocument(h('body', {}, h('header', {}, h('div', {}, after)), h('main', {})));
  const moved = resolveAnchor(edited, stored);
  assert.deepEqual([moved.found, moved.exact, moved.element], [true, false, after]);

  // Same selector now hits a different tag → not exact; falls back to text.
  const p = h('p', {}, 'unrelated');
  const sameSelector = fakeDocument(h('body', {}, h('main', {}, h('section', {}, p))));
  assert.equal(resolveAnchor(sameSelector, { selector: 'main > section > *', text: 'nothing like it at all', html: '<h2>' }).found, false);

  // Text shorter than 12 chars never re-matches → detached.
  const short = { selector: 'main > h3.gone', text: 'Pricing', html: '<h3>' };
  const docShort = fakeDocument(h('body', {}, h('h3', {}, 'Pricing')));
  assert.deepEqual(resolveAnchor(docShort, short), { found: false, exact: false, element: null });
});

test('anchor: innermost text match wins; invalid stored selectors do not throw', () => {
  const inner = h('div', { class: 'inner' }, 'Twelve chars or more here');
  const outer = h('div', { class: 'outer' }, inner);
  const doc = fakeDocument(h('body', {}, outer));
  const match = resolveAnchor(doc, { selector: 'div::bogus((', text: 'Twelve chars or more', html: '<div>' });
  assert.equal(match.element, inner);
  assert.equal(match.exact, false);
});

// ---- links.ts ----

test('links: fragments, screens, externals and blocked schemes', () => {
  const file = 'screens/home.html';
  assert.deepEqual(classifyLink('#plans', file), { kind: 'fragment', id: 'plans' });
  assert.deepEqual(classifyLink('#', file), { kind: 'fragment', id: '' });
  assert.deepEqual(classifyLink('pricing.html#plans', file), { kind: 'navigate', href: 'screens/pricing.html', hash: '#plans' });
  assert.deepEqual(classifyLink('./pricing.html?x=1', file), { kind: 'navigate', href: 'screens/pricing.html', hash: '' });
  assert.deepEqual(classifyLink('../index.html', file), { kind: 'navigate', href: 'index.html', hash: '' });
  assert.deepEqual(classifyLink('../../../../etc/x.html', file), { kind: 'navigate', href: 'etc/x.html', hash: '' });
  assert.deepEqual(classifyLink('home.html#top', file), { kind: 'fragment', id: 'top' });
  assert.equal(classifyLink('home.html', file).kind, 'blocked');
  assert.deepEqual(classifyLink('https://example.com/a?b=1', file), { kind: 'external', url: 'https://example.com/a?b=1' });
  assert.deepEqual(classifyLink('//example.com/x', file), { kind: 'external', url: 'https://example.com/x' });
  for (const href of ['javascript:alert(1)', 'mailto:a@b.c', 'data:text/html,hi', 'file:///C:/x.html', '', 'assets/logo.png', 'blob:https://x/y']) {
    assert.equal(classifyLink(href, file).kind, 'blocked', href);
  }
  assert.deepEqual(classifyGoto('checkout'), { kind: 'navigate', href: 'screens/checkout.html', hash: '' });
  assert.equal(classifyGoto('../evil').kind, 'blocked');
});
