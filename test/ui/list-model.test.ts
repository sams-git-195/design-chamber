import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { DesignSummary } from '../../src/shared/types.ts';
import { relativeTime, plural, folderName, middlePath, zoomPercent } from '../../src/ui/model/format.ts';
import { emptyKind, filterDesigns, kindSummary, rowAriaLabel, sortDesigns, tabCounts } from '../../src/ui/model/list-model.ts';

const design = (over: Partial<DesignSummary> & Pick<DesignSummary, 'slug'>): DesignSummary => ({
  kind: 'canvas',
  title: over.slug,
  created: '2026-10-01T10:00:00.000Z',
  updated: '2026-10-01T10:00:00.000Z',
  pending: false,
  screenCount: 3,
  viewports: [],
  sessionId: null,
  openComments: 0,
  thumb: { state: 'ready', key: null },
  warnings: [],
  ...over,
});

const set = [
  design({ slug: 'coffee', title: 'Coffee subscription', updated: '2026-10-26T10:00:00.000Z', created: '2026-10-20T10:00:00.000Z' }),
  design({ slug: 'invoice', title: 'Invoice template', kind: 'artifact', screenCount: 0, updated: '2026-10-25T10:00:00.000Z', created: '2026-10-25T09:00:00.000Z' }),
  design({ slug: 'onboarding', title: 'Onboarding', pending: true, updated: '2026-10-27T10:00:00.000Z', created: '2026-10-10T10:00:00.000Z' }),
];

test('filterDesigns narrows by tab and by a case-insensitive title or slug match', () => {
  assert.deepEqual(filterDesigns(set, '', 'artifact').map((d) => d.slug), ['invoice']);
  assert.deepEqual(filterDesigns(set, 'COFFEE', 'all').map((d) => d.slug), ['coffee']);
  assert.deepEqual(filterDesigns(set, 'on', 'canvas').map((d) => d.slug), ['coffee', 'onboarding']);
  assert.deepEqual(filterDesigns(set, '  ', 'all'), set);
});

test('tabCounts follow the search so a tab never counts rows the search hides', () => {
  assert.deepEqual(tabCounts(set, ''), { all: 3, canvas: 2, artifact: 1 });
  assert.deepEqual(tabCounts(set, 'invoice'), { all: 1, canvas: 0, artifact: 1 });
});

test('sortDesigns orders by updated/created newest first and by title A–Z, without mutating the input', () => {
  const before = set.map((d) => d.slug);
  assert.deepEqual(sortDesigns(set, 'updated').map((d) => d.slug), ['onboarding', 'coffee', 'invoice']);
  assert.deepEqual(sortDesigns(set, 'created').map((d) => d.slug), ['invoice', 'coffee', 'onboarding']);
  assert.deepEqual(sortDesigns(set, 'title').map((d) => d.slug), ['coffee', 'invoice', 'onboarding']);
  assert.deepEqual(set.map((d) => d.slug), before);
});

test('emptyKind tells "nothing written yet" from "the search hides everything"', () => {
  assert.equal(emptyKind([], []), 'no-designs');
  assert.equal(emptyKind(set, []), 'no-matches');
  assert.equal(emptyKind(set, set), 'none');
});

test('kindSummary and rowAriaLabel use the glossary words and singular/plural correctly', () => {
  assert.equal(kindSummary(design({ slug: 'a', screenCount: 1 })), 'Canvas · 1 screen');
  assert.equal(kindSummary(design({ slug: 'a', screenCount: 3 })), 'Canvas · 3 screens');
  assert.equal(kindSummary(design({ slug: 'a', kind: 'artifact' })), 'Artifact');
  assert.equal(rowAriaLabel(design({ slug: 'a', title: 'A', pending: true, openComments: 2 })), 'A, Canvas · 3 screens, waiting for the agent, 2 open comments');
});

test('relativeTime is plain, locale-aware and tolerant of bad input', () => {
  const now = Date.parse('2026-10-26T12:00:00.000Z');
  assert.equal(relativeTime('2026-10-26T11:59:40.000Z', now, 'en'), 'just now');
  assert.match(relativeTime('2026-10-26T11:56:00.000Z', now, 'en'), /4 min/);
  assert.match(relativeTime('2026-10-26T09:00:00.000Z', now, 'en'), /3 hr/);
  assert.equal(relativeTime('2026-10-25T12:00:00.000Z', now, 'en'), 'yesterday');
  assert.equal(relativeTime('not a date', now, 'en'), '');
});

test('small format helpers', () => {
  assert.equal(plural(1, 'comment'), '1 comment');
  assert.equal(plural(0, 'comment'), '0 comments');
  assert.equal(folderName('C:\\Users\\you\\Documents\\Designs\\'), 'Designs');
  assert.equal(zoomPercent(0.254), '25%');
});

test('middlePath shortens a long folder path in the middle and keeps the last folder whole', () => {
  const long = 'C:\\Users\\you\\AppData\\Local\\Temp\\dc-smoke-designs';
  assert.equal(middlePath('C:\\Users\\you\\Documents\\Designs'), 'C:\\Users\\you\\Documents\\Designs', 'short paths stay');
  assert.equal(middlePath(long, 30), 'C:\\…\\Temp\\dc-smoke-designs');
  assert.equal(middlePath('/home/someone/projects/client-work/designs/archive', 26), '/…/designs/archive');
  assert.equal(middlePath('C:\\Users\\you\\Documents\\Designs\\', 20), 'C:\\…\\Designs');
  // The last folder alone is longer than the budget: only then is it cut, at its end.
  const short = middlePath(`C:\\Users\\you\\${'a-very-long-folder-name-'.repeat(3)}end`, 24);
  assert.ok(short.length <= 24, short);
  assert.ok(short.endsWith('…'), short);
});
