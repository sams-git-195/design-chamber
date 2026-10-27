import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Comment, Screen, VersionSummary } from '../../src/shared/types.ts';
import { countByStatus, groupComments, pinAriaLabel, pinGlyph, pinNumbers, sendState } from '../../src/ui/model/comments-model.ts';
import { reasonLabel, restoreConfirmBody, versionRows, viewingBanner } from '../../src/ui/model/versions-model.ts';

const comment = (id: string, over: Partial<Comment> = {}): Comment => ({
  id,
  screen: 'home',
  viewport: 'laptop',
  anchor: { selector: 'h1', text: 'Hello', html: '<h1>', rect: { x: 0, y: 0, w: 10, h: 10 }, point: { x: 0.5, y: 0.5 } },
  body: 'Make it shorter',
  status: 'open',
  created: '2026-10-26T10:00:00.000Z',
  sentAt: null,
  sentVersion: null,
  ...over,
});

const screens: Screen[] = [
  { id: 'home', title: 'Home', file: 'screens/home.html' },
  { id: 'pricing', title: 'Pricing', file: 'screens/pricing.html' },
];

test('pinNumbers follow creation order, not array order, and break ties by array order', () => {
  const list = [
    comment('c_b', { created: '2026-10-26T10:05:00.000Z' }),
    comment('c_a', { created: '2026-10-26T10:00:00.000Z' }),
    comment('c_c', { created: '2026-10-26T10:05:00.000Z' }),
  ];
  const numbers = pinNumbers(list);
  assert.equal(numbers.get('c_a'), 1);
  assert.equal(numbers.get('c_b'), 2);
  assert.equal(numbers.get('c_c'), 3);
});

test('groupComments keeps wall order, puts artifact comments first and surfaces orphans', () => {
  const list = [comment('c_1', { screen: 'pricing' }), comment('c_2', { screen: 'home' }), comment('c_3', { screen: 'gone' }), comment('c_4', { screen: null })];
  const groups = groupComments(list, screens, 'Artifact');
  assert.deepEqual(groups.map((g) => g.key), ['artifact', 'home', 'pricing', '__missing']);
  assert.deepEqual(groups.map((g) => g.comments.map((c) => c.id)), [['c_4'], ['c_2'], ['c_1'], ['c_3']]);
});

test('sendState says why it is disabled and counts only open comments', () => {
  const none = sendState([comment('c_1', { status: 'sent' })], true);
  assert.equal(none.enabled, false);
  assert.match(none.reason ?? '', /Add a comment/);
  const two = sendState([comment('c_1'), comment('c_2'), comment('c_3', { status: 'resolved' })], true);
  assert.deepEqual([two.enabled, two.label, two.reason], [true, 'Send 2 comments to chat', null]);
  assert.equal(sendState([comment('c_1')], true).label, 'Send 1 comment to chat');
  assert.match(sendState([comment('c_1')], false).reason ?? '', /new chat/);
});

test('pin glyph and label never rely on colour alone', () => {
  assert.equal(pinGlyph(comment('c_1'), 3), '3');
  assert.equal(pinGlyph(comment('c_1', { status: 'resolved' }), 3), '✓');
  assert.equal(pinAriaLabel(comment('c_1', { status: 'sent' }), 2), 'Comment 2: Make it shorter (sent to chat)');
  assert.ok(pinAriaLabel(comment('c_1', { body: 'x'.repeat(100) }), 1).includes('…'));
  assert.deepEqual(countByStatus([comment('a'), comment('b', { status: 'sent' }), comment('c', { status: 'sent' })]), { open: 1, sent: 2, resolved: 0 });
});

const version = (n: number, reason: VersionSummary['reason']): VersionSummary => ({
  id: `v${n}`,
  n,
  created: '2026-10-26T10:00:00.000Z',
  reason,
  sessionId: null,
  treeHash: `hash${n}`,
  bytes: 10,
  fileCount: 4,
});

test('versionRows lists newest first and marks current only when nothing changed since', () => {
  const rows = versionRows([version(1, 'auto'), version(3, 'turn'), version(2, 'restore-point')], false);
  assert.deepEqual(rows.map((r) => r.title), ['v3', 'v2', 'v1']);
  assert.deepEqual(rows.map((r) => r.current), [true, false, false]);
  assert.equal(versionRows([version(1, 'auto')], true)[0]?.current, false);
});

test('version copy uses the labels the spec names', () => {
  assert.equal(reasonLabel('turn'), 'After agent turn');
  assert.equal(reasonLabel('manual'), 'Saved manually');
  assert.equal(reasonLabel('restore-point'), 'Before restore');
  assert.equal(viewingBanner(12, false), 'Viewing v12 — read only');
  assert.match(viewingBanner(12, true), /Comparing v12/);
  assert.match(restoreConfirmBody(7), /saved as a version first/);
});
