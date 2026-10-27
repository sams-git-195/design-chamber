// Slug rules (docs/SPEC.md §6.1, §9.1): the folder-name contract every design path rests on.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ApiError } from '../../../src/service/http.ts';
import { SLUG_BASE_MAX } from '../../../src/shared/limits.ts';
import { assertSlug, isSlug, slugify, uniqueSlug } from '../../../src/service/paths.ts';

describe('isSlug / assertSlug', () => {
  test('accepts the documented pattern only', () => {
    for (const ok of ['a', 'design', 'home-2', '0-1-2', 'x'.repeat(63)]) assert.equal(isSlug(ok), true, ok);
    for (const bad of ['', '-start', 'End-', 'UPPER', 'with space', 'with.dot', 'with/slash', 'with\\back', 'a'.repeat(64), 'café', '..']) {
      assert.equal(isSlug(bad), false, bad);
    }
    assert.equal(isSlug(42), false);
    assert.equal(isSlug(undefined), false);
  });

  test('assertSlug throws bad-slug and passes valid slugs through', () => {
    assert.equal(assertSlug('my-design'), 'my-design');
    assert.throws(
      () => assertSlug('../etc'),
      (error: unknown) => error instanceof ApiError && error.code === 'bad-slug',
    );
  });
});

describe('slugify', () => {
  const cases: [string, string][] = [
    ['Checkout Redesign', 'checkout-redesign'],
    ['Café Müesli — naïve', 'cafe-muesli-naive'],
    ['  Hello   World!! ', 'hello-world'],
    ['v1.2 release', 'v1-2-release'],
    ['!!!', 'design'],
    ['', 'design'],
    ['中文标题', 'design'],
    ['Ångström Ünicode', 'angstrom-unicode'],
  ];
  for (const [title, expected] of cases) {
    test(`"${title}" → "${expected}"`, () => {
      assert.equal(slugify(title), expected);
    });
  }

  test('Windows device names (con, nul, aux, prn, com1-9, lpt1-9) never become a folder name', () => {
    for (const name of ['CON', 'nul', 'Aux', 'prn', 'com1', 'COM9', 'lpt1', 'lpt9']) {
      const slug = slugify(name);
      assert.equal(slug, `${name.toLowerCase()}-design`, name);
      assert.equal(isSlug(slug), true);
    }
    // Only the bare name is reserved; longer slugs that contain one are ordinary.
    assert.equal(slugify('Con 2026'), 'con-2026');
    assert.equal(slugify('console'), 'console');
    assert.equal(slugify('com10'), 'com10');
  });

  test('uniqueSlug never starts from a Windows device name', async () => {
    assert.equal(await uniqueSlug('nul', async () => false), 'design');
  });

  test('long titles fold to at most SLUG_BASE_MAX chars and stay valid slugs', () => {
    const long = 'word '.repeat(40).trim();
    const slug = slugify(long);
    assert.ok(slug.length <= SLUG_BASE_MAX, `length ${slug.length}`);
    assert.equal(isSlug(slug), true);
    assert.ok(long.startsWith('word'), 'sanity: the source starts with the slug base');
  });

  test('a long title is cut at a word boundary, never mid-word (smoke m4)', () => {
    const slug = slugify('A landing page and a pricing screen for a neighbourhood bike co-op');
    assert.equal(slug, 'a-landing-page-and-a-pricing-screen-for-a');
    assert.ok(slug.length <= SLUG_BASE_MAX);
    // A word ending exactly at the limit is kept whole.
    const exact = `${'b'.repeat(SLUG_BASE_MAX - 5)} word tail`;
    assert.equal(slugify(exact), `${'b'.repeat(SLUG_BASE_MAX - 5)}-word`);
    // One word longer than the limit has no boundary: a hard cut.
    assert.equal(slugify('x'.repeat(SLUG_BASE_MAX + 10)), 'x'.repeat(SLUG_BASE_MAX));
  });

  test('a slice ending mid-dash does not leave a trailing dash', () => {
    const title = `${'a'.repeat(SLUG_BASE_MAX - 1)} - suffix`;
    const slug = slugify(title);
    assert.ok(!slug.endsWith('-'), slug);
    assert.ok(slug.length <= SLUG_BASE_MAX);
  });
});

describe('uniqueSlug', () => {
  const taken = (...slugs: string[]): ((slug: string) => Promise<boolean>) => {
    const set = new Set(slugs);
    return async (slug) => set.has(slug);
  };

  test('a free base is used as is', async () => {
    assert.equal(await uniqueSlug('home', taken()), 'home');
  });

  test('suffixes -2, -3… until free (SPEC §6.1)', async () => {
    assert.equal(await uniqueSlug('home', taken('home')), 'home-2');
    assert.equal(await uniqueSlug('home', taken('home', 'home-2')), 'home-3');
    assert.equal(await uniqueSlug('home', taken('home', 'home-2', 'home-3', 'home-4')), 'home-5');
  });

  test('an invalid base falls back to "design"', async () => {
    assert.equal(await uniqueSlug('../evil', taken()), 'design');
    assert.equal(await uniqueSlug('../evil', taken('design')), 'design-2');
  });

  test('gives up with a conflict when everything is taken', async () => {
    await assert.rejects(
      uniqueSlug('home', async () => true),
      (error: unknown) => error instanceof ApiError && error.code === 'conflict',
    );
  });
});
