import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { buildContinuePrompt, buildRevisionPrompt, type RevisionInput } from '../../src/shared/agent/revision-prompt.ts';
import { REVISION_TEXT_MAX } from '../../src/shared/limits.ts';
import type { Comment } from '../../src/shared/types.ts';
import { comment } from './helpers.ts';
import { assertSnapshot } from './snapshot.ts';

const FOLDER = 'C:\\Users\\you\\Documents\\Designs\\checkout-redesign';

const input = (comments: Comment[], extra: Partial<RevisionInput> = {}): RevisionInput => ({
  title: 'Checkout redesign',
  kind: 'canvas',
  folder: FOLDER,
  screens: [
    { id: 'home', title: 'Home', file: 'screens/home.html' },
    { id: 'pay', title: 'Payment', file: 'screens/pay.html' },
  ],
  viewports: [
    { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
    { id: 'phone', label: 'Phone', width: 390, height: 844 },
  ],
  comments,
  ...extra,
});

/** Three comments with long anchors and bodies, so each ladder step is needed in turn. */
const heavy = (count: number, bodyLength = 300): Comment[] =>
  Array.from({ length: count }, (_, i) =>
    comment(`c_heavy${i}`, {
      anchor: { selector: `main > div:nth-of-type(${i + 1})`, text: `Text of element ${i} `.repeat(8).slice(0, 120), html: `<div class="${'c'.repeat(160)}">`, rect: { x: 0, y: 0, w: 1, h: 1 }, point: { x: 0, y: 0 } },
      body: `${i}: ${'b'.repeat(bodyLength)}`,
    }),
  );

describe('revision prompt format', () => {
  test('canvas comment: header, instruction, screen · viewport, element, text, html, body', () => {
    const { text, commentIds, omitted, level } = buildRevisionPrompt(input([comment('c_aaaa1')]));
    assert.deepEqual(commentIds, ['c_aaaa1']);
    assert.deepEqual(omitted, []);
    assert.equal(level, 0);
    assert.equal(
      text,
      [
        `[Design Chamber] Revise "Checkout redesign" — 1 comment. Folder: ${FOLDER}. Rules: ${FOLDER}\\.chamber\\RULES.md`,
        'Change only what the comments ask; keep everything else. Update design.json "updated". Reply per comment number.',
        '1. Screen "Home" (screens/home.html) @ Laptop 1280×800',
        '   element: `main > section.hero > h1`',
        '   text: "Ship faster than ever before"  html: `<h1 class="hero-title">`',
        '   → Make this shorter',
      ].join('\n'),
    );
  });

  test('artifact comment names index.html; an unknown viewport or screen falls back to its id', () => {
    const artifact = buildRevisionPrompt(input([comment('c_aaaa1', { screen: null, viewport: 'phone' })], { kind: 'artifact', screens: [] })).text;
    assert.ok(artifact.includes('1. Artifact index.html @ Phone 390×844'));
    const stale = buildRevisionPrompt(input([comment('c_aaaa1', { screen: 'gone', viewport: 'old' })])).text;
    assert.ok(stale.includes('1. Screen "gone" (screens/gone.html) @ old'));
  });

  test('numbers comments in order, plural header, multi-line bodies stay under their number', () => {
    const { text } = buildRevisionPrompt(input([comment('c_aaaa1', { body: 'First line\n2. looks like a list item\nthird' }), comment('c_aaaa2', { screen: 'pay', body: 'Second' })]));
    assert.ok(text.includes('— 2 comments.'));
    assert.ok(text.includes('   → First line\n   2. looks like a list item\n   third\n2. Screen "Payment"'));
    assert.ok(text.includes('2. Screen "Payment" (screens/pay.html) @ Laptop 1280×800'));
  });

  test('flags a moved or detached anchor, and omits empty text/html parts', () => {
    const bare = comment('c_aaaa1', { anchor: { ...comment('x').anchor, text: '', html: '' } });
    const { text } = buildRevisionPrompt(input([bare, comment('c_aaaa2'), comment('c_aaaa3')], { anchorStates: { c_aaaa2: 'moved', c_aaaa3: 'detached' } }));
    assert.ok(text.includes('1. Screen "Home" (screens/home.html) @ Laptop 1280×800\n   element: `main > section.hero > h1`\n   → Make this shorter'));
    assert.ok(text.includes('element: `main > section.hero > h1` (moved — matched by text)'));
    assert.ok(text.includes('element: `main > section.hero > h1` (not found in current file)'));
  });

  test('a selector with a backtick still renders as one code span', () => {
    const odd = comment('c_aaaa1', { anchor: { ...comment('x').anchor, selector: 'a[title="x`y"]' } });
    assert.ok(buildRevisionPrompt(input([odd])).text.includes('element: `` a[title="x`y"] ``'));
  });
});

describe('revision prompt truncation ladder', () => {
  const comments = heavy(6);
  const full = buildRevisionPrompt(input(comments, { maxChars: 1_000_000 }));

  test('fits → level 0, everything kept', () => {
    assert.equal(full.level, 0);
    assert.equal(full.commentIds.length, 6);
    assert.ok(full.text.includes('html: '));
  });

  test('level 1: just over the cap drops each anchor html, keeps text and every comment', () => {
    const result = buildRevisionPrompt(input(comments, { maxChars: full.text.length - 1 }));
    assert.equal(result.level, 1);
    assert.ok(!result.text.includes('html: '), 'html dropped');
    assert.ok(result.text.includes('text: "Text of element 0'), 'text kept in full');
    assert.ok(!result.text.includes('…'));
    assert.equal(result.commentIds.length, 6);
    assert.deepEqual(result.omitted, []);
    assert.ok(result.text.length <= full.text.length - 1);
  });

  test('level 2: still over → anchor text is shortened to 40 characters', () => {
    const one = buildRevisionPrompt(input(comments, { maxChars: full.text.length - 1 }));
    const result = buildRevisionPrompt(input(comments, { maxChars: one.text.length - 1 }));
    assert.equal(result.level, 2);
    assert.ok(result.text.includes('…"'), 'text cut with an ellipsis');
    assert.equal(result.commentIds.length, 6);
    assert.deepEqual(result.omitted, []);
    assert.ok(result.text.length <= one.text.length - 1);
  });

  test('level 3: still over → the first K comments, the rest listed as omitted, header says K of N', () => {
    const one = buildRevisionPrompt(input(comments, { maxChars: full.text.length - 1 }));
    const two = buildRevisionPrompt(input(comments, { maxChars: one.text.length - 1 }));
    const result = buildRevisionPrompt(input(comments, { maxChars: two.text.length - 1 }));
    assert.equal(result.level, 3);
    assert.ok(result.commentIds.length >= 1 && result.commentIds.length < 6);
    assert.deepEqual([...result.commentIds, ...result.omitted], comments.map((c) => c.id), 'kept + omitted = all, in order');
    assert.ok(result.omitted.length > 0);
    assert.ok(result.text.includes(`— ${result.commentIds.length} comments of 6 (the rest will follow in a later message).`));
    assert.ok(result.text.length <= two.text.length - 1);
    assert.ok(!result.text.includes(`${result.commentIds.length + 1}. Screen`));
  });

  test('with the real host cap, nine 2 000-character comments yield one message ≤ 16 000 and the rest omitted', () => {
    const nine = heavy(9, 1990);
    const result = buildRevisionPrompt(input(nine));
    assert.ok(result.text.length <= REVISION_TEXT_MAX, String(result.text.length));
    assert.equal(result.level, 3);
    assert.equal(result.commentIds.length + result.omitted.length, 9);
    assert.ok(result.commentIds.length >= 6);
  });

  test('one comment alone over the cap is kept with its body cut, never dropped', () => {
    const huge = comment('c_aaaa1', { body: 'x'.repeat(30_000) });
    const result = buildRevisionPrompt(input([huge, comment('c_aaaa2')]));
    assert.deepEqual(result.commentIds, ['c_aaaa1']);
    assert.deepEqual(result.omitted, ['c_aaaa2']);
    assert.ok(result.text.length <= REVISION_TEXT_MAX);
    assert.ok(result.text.includes('x…'));
  });
});

describe('continue prompt', () => {
  test('names the design, the rules file, the open comments, and asks for nothing to change yet', () => {
    const text = buildContinuePrompt({ title: 'Checkout redesign', kind: 'canvas', folder: FOLDER, openComments: 2 });
    assert.ok(text.includes(`Resuming the canvas "Checkout redesign". Folder: ${FOLDER}. Rules: ${FOLDER}\\.chamber\\RULES.md`));
    assert.ok(text.includes('Do not change any file yet.'));
    assert.ok(text.includes('2 pinned comments are waiting'));
    assert.ok(!buildContinuePrompt({ title: 't', kind: 'artifact', folder: FOLDER, openComments: 0 }).includes('pinned'));
    assert.ok(buildContinuePrompt({ title: 't', kind: 'artifact', folder: FOLDER, openComments: 1 }).includes('1 pinned comment is waiting'));
  });
});

describe('golden sample', () => {
  test('a canvas revision with a moved and a detached element', async () => {
    const result = buildRevisionPrompt(
      input(
        [
          comment('c_aaaa1'),
          comment('c_aaaa2', { screen: 'pay', viewport: 'phone', body: 'Button too small.\nMake it 48px tall.', anchor: { ...comment('x').anchor, selector: '#pay-now', text: 'Pay now', html: '<button id="pay-now" class="btn">' } }),
          comment('c_aaaa3', { anchor: { ...comment('x').anchor, selector: 'footer > p.legal', text: 'Terms apply', html: '<p class="legal">' }, body: 'Remove the legal line.' }),
        ],
        { anchorStates: { c_aaaa2: 'moved', c_aaaa3: 'detached' } },
      ),
    );
    await assertSnapshot('revision.canvas-three-comments.txt', result.text);
  });
});
