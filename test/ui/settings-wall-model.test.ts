import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Screen } from '../../src/shared/types.ts';
import { validateBrief, presetOptions } from '../../src/ui/model/new-model.ts';
import { browserStatus, isAbsolutePath, permissionSnippet, validateRootInput } from '../../src/ui/model/settings-model.ts';
import { artboardLabel } from '../../src/ui/model/format.ts';
import { LABEL_TAIL_MAX, PIN_FAN_SCALE, alignTop, boardAt, clusterPins, fanOut, frameToScreen, labelWidth, liveBoards, pinFramePoint, screenToFrame, separatingScale } from '../../src/ui/model/wall-model.ts';

test('validateRootInput rejects what the service would refuse, with a sentence that says what to do', () => {
  const root = 'C:\\Users\\you\\Documents\\Designs';
  assert.match(validateRootInput('   ', root) ?? '', /full path/);
  assert.match(validateRootInput('Designs', root) ?? '', /full path/);
  assert.match(validateRootInput('C:\\', root) ?? '', /not the drive itself/);
  assert.match(validateRootInput(root, root) ?? '', /already/);
  assert.equal(validateRootInput('D:\\Work\\Designs', root), null);
  assert.equal(validateRootInput('/home/you/designs', root), null);
  assert.equal(validateRootInput('\\\\nas\\share\\designs', root), null);
});

test('isAbsolutePath knows drive, UNC, posix and home paths', () => {
  for (const ok of ['C:\\a', 'c:/a', '\\\\srv\\share', '/a', '~/a']) assert.equal(isAbsolutePath(ok), true, ok);
  for (const bad of ['a', './a', '..\\a', 'C:a']) assert.equal(isAbsolutePath(bad), false, bad);
});

test('permissionSnippet is valid JSON with a forward-slash glob', () => {
  const parsed: unknown = JSON.parse(permissionSnippet('C:\\Users\\you\\Documents\\Designs\\'));
  assert.deepEqual(parsed, { permission: { external_directory: { 'C:/Users/you/Documents/Designs/**': 'allow' } } });
});

test('browserStatus warns when no browser is found', () => {
  assert.equal(browserStatus(null, 'none').tone, 'warning');
  assert.equal(browserStatus('C:\\chrome.exe', 'detected').tone, 'success');
  assert.match(browserStatus('C:\\chrome.exe', 'setting').title, /chosen/);
});

test('new-design form helpers', () => {
  assert.equal(validateBrief('ok'), null);
  assert.match(validateBrief('x'.repeat(2001)) ?? '', /under 2000/);
  const options = presetOptions([{ id: 'minimal-saas', name: 'Minimal SaaS', bestFor: 'dashboards' }]);
  assert.deepEqual(options.map((o) => o.id), ['', 'minimal-saas']);
});

const camera = { x: 100, y: 50, scale: 0.5 };
const board = { x: 200, y: 80, w: 1280, h: 800 };

test('screen ↔ frame mapping round-trips and honours the camera scale', () => {
  const frame = screenToFrame(camera, board, { x: 100 + 0.5 * (200 + 40), y: 50 + 0.5 * (80 + 60) });
  assert.deepEqual(frame, { x: 40, y: 60 });
  assert.deepEqual(frameToScreen(camera, board, frame), { x: 220, y: 120 });
});

test('boardAt picks the topmost artboard under a point, or null on the background', () => {
  const boards = [
    { id: 'a', rect: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'b', rect: { x: 50, y: 50, w: 100, h: 100 } },
  ];
  const cam = { x: 0, y: 0, scale: 1 };
  assert.equal(boardAt(cam, boards, { x: 60, y: 60 })?.id, 'b');
  assert.equal(boardAt(cam, boards, { x: 10, y: 10 })?.id, 'a');
  assert.equal(boardAt(cam, boards, { x: 500, y: 500 }), null);
});

test('pinFramePoint follows the element and the frame scroll', () => {
  const rect = { x: 120, y: 340, w: 600, h: 64 };
  assert.deepEqual(pinFramePoint(rect, { x: 0.5, y: 0.5 }, { x: 0, y: 300 }), { x: 420, y: 72 });
});

test('alignTop keeps the zoom and x, and puts the content top the given padding below the surface top', () => {
  const bounds = { x: 0, y: 0, w: 1280, h: 828 };
  const aligned = alignTop({ x: 12, y: 300, scale: 0.25 }, bounds, 16);
  assert.deepEqual(aligned, { x: 12, y: 16, scale: 0.25 });
  // a content box that starts above the origin (labels sit above artboards) still lands at the padding
  assert.equal(alignTop({ x: 0, y: 0, scale: 0.5 }, { x: 0, y: -28, w: 10, h: 10 }, 16).y, 30);
});

const screens: Screen[] = [
  { id: 'home', title: 'Home', file: 'screens/home.html' },
  { id: 'pricing', title: 'Pricing', file: 'screens/pricing.html' },
];

test('liveBoards keeps the boards nearest the centre within the budget and drops far ones', () => {
  const boards = [
    { id: 'near', rect: { x: 0, y: 0, w: 100, h: 100 } },
    { id: 'mid', rect: { x: 400, y: 0, w: 100, h: 100 } },
    { id: 'far', rect: { x: 100000, y: 0, w: 100, h: 100 } },
  ];
  const cam = { x: 0, y: 0, scale: 1 };
  const surface = { w: 600, h: 300 };
  assert.deepEqual(liveBoards(boards, cam, surface, 12, 0.5).map((b) => b.id), ['mid', 'near']);
  assert.deepEqual(liveBoards(boards, cam, surface, 1, 0.5).map((b) => b.id), ['mid']);
});

test('clusterPins folds pins closer than a pin width on screen, anchored on the first; zooming in separates them', () => {
  const pins = [
    { id: 'a', x: 100, y: 100 },
    { id: 'b', x: 140, y: 110 },
    { id: 'c', x: 600, y: 100 },
  ];
  assert.deepEqual(clusterPins(pins, 0.26, 24), [
    { ids: ['a', 'b'], x: 100, y: 100 },
    { ids: ['c'], x: 600, y: 100 },
  ]);
  assert.equal(clusterPins(pins, 1, 24).length, 3);
  // Zooming to the separating scale pulls the pair at least a pin width apart on screen.
  const target = separatingScale(pins.slice(0, 2), 0.26, 24);
  assert.ok(target > 0.26 && target <= PIN_FAN_SCALE);
  assert.equal(clusterPins(pins.slice(0, 2), target, 24).length, 2);
  // Pins on the very same spot cannot be separated by zoom: go to 100 %, where they fan out.
  assert.equal(separatingScale([{ id: 'a', x: 5, y: 5 }, { id: 'b', x: 5, y: 5 }], 0.3, 24), PIN_FAN_SCALE);
});

test('fanOut lays a group out as a row of whole pins at the current zoom', () => {
  const row = fanOut({ ids: ['a', 'b', 'c'], x: 10, y: 20 }, 2, 24, 4);
  assert.deepEqual(row, [
    { id: 'a', x: 10, y: 20 },
    { id: 'b', x: 24, y: 20 },
    { id: 'c', x: 38, y: 20 },
  ]);
});

test('artboard labels name the screen, the viewport and its size; narrow columns borrow the gap', () => {
  const phone = { id: 'phone', label: 'Phone', width: 390, height: 844 };
  assert.deepEqual(artboardLabel('Home', phone), { name: 'Home', detail: 'Phone · 390×844', full: 'Home · Phone · 390×844' });
  const rect = { x: 1376, y: 28, w: 390, h: 844 };
  assert.equal(labelWidth(rect, null, 0.26), LABEL_TAIL_MAX);
  assert.equal(labelWidth({ ...rect, x: 0 }, 1376, 0.26), 1376 * 0.26 - 12);
  assert.equal(labelWidth(rect, null, 1), 390);
});
