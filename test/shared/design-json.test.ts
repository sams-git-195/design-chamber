import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  applyServiceState,
  createDesignDocument,
  mergeServiceFields,
  normalizeDesign,
  normalizeServiceState,
  parseComment,
  parseDesignJsonText,
  serializeJson,
  serviceFieldsDiffer,
  serviceStateOf,
  stripForVersion,
  VIEWPORT_LAPTOP,
  VIEWPORT_PHONE,
  type NormalizeOptions,
} from '../../src/shared/design-json.ts';
import type { JsonObject, ServiceState } from '../../src/shared/types.ts';

const OPTS: NormalizeOptions = { fallbackTitle: 'my-slug', fallbackTime: '2026-01-01T00:00:00.000Z' };
const T0 = '2026-10-26T18:00:00.000Z';
const T1 = '2026-10-26T18:20:00.000Z';

const comment = (id: string, extra: Partial<Record<string, unknown>> = {}): JsonObject => ({
  id,
  screen: 'home',
  viewport: 'laptop',
  anchor: { selector: 'main > h1', text: 'Ship faster', html: '<h1 class="hero">', rect: { x: 120, y: 340, w: 600, h: 64 }, point: { x: 0.12, y: 0.5 } },
  body: 'Make this shorter',
  status: 'open',
  created: T0,
  sentAt: null,
  sentVersion: null,
  ...(extra as JsonObject),
});

const validCanvas = (): JsonObject => ({
  version: 1,
  kind: 'canvas',
  title: 'Checkout redesign',
  created: T0,
  updated: T1,
  brief: 'A calmer checkout',
  sessionId: 'ses_abc',
  projectDirectory: 'C:\\Users\\me\\shop',
  preset: 'minimal-saas',
  viewports: [
    { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
    { id: 'phone', label: 'Phone', width: 390, height: 844 },
  ],
  screens: [
    { id: 'home', title: 'Home', file: 'screens/home.html', viewports: ['laptop', 'phone'], description: 'Landing' },
    { id: 'checkout', title: 'Checkout', file: 'screens/checkout.html' },
  ],
  designSystem: { confirmed: true },
  comments: [comment('c_8f3k2')],
});

const codes = (warnings: { code: string }[]): string[] => warnings.map((w) => w.code);

describe('normalizeDesign — valid input', () => {
  test('a complete canvas reads back unchanged with no warnings', () => {
    const { design, extra, warnings } = normalizeDesign(validCanvas(), OPTS);
    assert.deepEqual(warnings, []);
    assert.deepEqual(extra, {});
    assert.equal(design.kind, 'canvas');
    assert.equal(design.title, 'Checkout redesign');
    assert.equal(design.created, T0);
    assert.equal(design.updated, T1);
    assert.equal(design.entry, null);
    assert.equal(design.sessionId, 'ses_abc');
    assert.equal(design.projectDirectory, 'C:\\Users\\me\\shop');
    assert.equal(design.preset, 'minimal-saas');
    assert.deepEqual(design.viewports.map((v) => v.id), ['laptop', 'phone']);
    assert.deepEqual(design.screens, [
      { id: 'home', title: 'Home', file: 'screens/home.html', viewports: ['laptop', 'phone'], description: 'Landing' },
      { id: 'checkout', title: 'Checkout', file: 'screens/checkout.html' },
    ]);
    assert.deepEqual(design.designSystem, { confirmed: true });
    assert.equal(design.comments.length, 1);
    assert.equal(design.comments[0]?.body, 'Make this shorter');
  });

  test('an artifact gets entry index.html and the Laptop default viewport', () => {
    const { design, warnings } = normalizeDesign({ kind: 'artifact', title: 'Pricing' }, OPTS);
    assert.deepEqual(warnings, []);
    assert.equal(design.entry, 'index.html');
    assert.deepEqual(design.viewports, [VIEWPORT_LAPTOP]);
    assert.deepEqual(design.screens, []);
    assert.equal(design.created, OPTS.fallbackTime);
  });

  test('a canvas without viewports gets Laptop + Phone', () => {
    const { design } = normalizeDesign({ kind: 'canvas', title: 'X' }, OPTS);
    assert.deepEqual(design.viewports, [VIEWPORT_LAPTOP, VIEWPORT_PHONE]);
  });

  test('screen file paths are normalised (backslashes, leading ./) and default from the id', () => {
    const raw = { kind: 'canvas', title: 'X', screens: [{ id: 'a', file: '.\\screens\\a.html' }, { id: 'b' }] };
    const { design, warnings } = normalizeDesign(raw, OPTS);
    assert.deepEqual(warnings, []);
    assert.deepEqual(design.screens.map((s) => [s.file, s.title]), [['screens/a.html', 'a'], ['screens/b.html', 'b']]);
  });
});

describe('normalizeDesign — unknown keys are kept', () => {
  test('top-level unknown keys travel in extra, verbatim', () => {
    const raw = { ...validCanvas(), $schema: 'design-chamber/design@1', notes: { nested: [1, 2, { deep: true }] }, tags: ['a'] };
    const { extra, warnings } = normalizeDesign(raw, OPTS);
    assert.deepEqual(warnings, []);
    assert.deepEqual(extra, { $schema: 'design-chamber/design@1', notes: { nested: [1, 2, { deep: true }] }, tags: ['a'] });
  });

  test('a "__proto__" key from JSON stays an own data key and does not touch prototypes', () => {
    const parsed = parseDesignJsonText('{"kind":"artifact","title":"X","__proto__":{"polluted":true}}', OPTS);
    assert.equal(Object.hasOwn(parsed.extra, '__proto__'), true);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(parsed.extra), Object.prototype);
  });
});

describe('normalizeDesign — invalid fields are dropped with warnings, never fatal', () => {
  test('bad viewports are dropped one by one; duplicates keep the first', () => {
    const raw = {
      kind: 'canvas',
      title: 'X',
      viewports: [
        { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
        { id: 'tiny', width: 100, height: 800 },
        { id: 'huge', width: 1280, height: 5000 },
        { id: 'frac', width: 1280.5, height: 800 },
        { id: 'bad id!', width: 1280, height: 800 },
        { id: 'laptop', width: 1440, height: 900 },
        'nope',
        { id: 'tablet', width: 834, height: 1194 },
      ],
    };
    const { design, warnings } = normalizeDesign(raw, OPTS);
    assert.deepEqual(design.viewports, [
      { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
      { id: 'tablet', label: 'tablet', width: 834, height: 1194 },
    ]);
    assert.deepEqual(codes(warnings), ['invalid-viewport', 'invalid-viewport', 'invalid-viewport', 'invalid-viewport', 'duplicate-viewport', 'invalid-viewport']);
    assert.equal(warnings[0]?.field, 'viewports[1]');
    assert.ok(warnings.every((w) => w.message.length > 0));
  });

  test('viewport bounds are inclusive: 200×200 and 3840×4320 are valid', () => {
    const raw = { kind: 'artifact', title: 'X', viewports: [{ id: 'min', width: 200, height: 200 }, { id: 'max', width: 3840, height: 4320 }] };
    const { design, warnings } = normalizeDesign(raw, OPTS);
    assert.deepEqual(warnings, []);
    assert.deepEqual(design.viewports.map((v) => v.id), ['min', 'max']);
  });

  test('more than 8 viewports keeps the first 8', () => {
    const viewports = Array.from({ length: 10 }, (_, i) => ({ id: `v${i}`, width: 400 + i, height: 800 }));
    const { design, warnings } = normalizeDesign({ kind: 'canvas', title: 'X', viewports }, OPTS);
    assert.equal(design.viewports.length, 8);
    assert.deepEqual(codes(warnings), ['too-many-viewports']);
  });

  test('an empty or all-invalid viewport list falls back to the defaults with a warning', () => {
    for (const viewports of [[], [{ id: 'x', width: 1, height: 1 }], 'laptop']) {
      const { design, warnings } = normalizeDesign({ kind: 'canvas', title: 'X', viewports }, OPTS);
      assert.deepEqual(design.viewports, [VIEWPORT_LAPTOP, VIEWPORT_PHONE]);
      assert.ok(warnings.length > 0, `expected a warning for ${JSON.stringify(viewports)}`);
    }
  });

  test('screens with a wrong file, a bad id or a duplicate id are dropped; unknown viewport refs are filtered', () => {
    const raw = {
      kind: 'canvas',
      title: 'X',
      screens: [
        { id: 'home', file: 'screens/home.html', viewports: ['laptop', 'watch'] },
        { id: 'escape', file: '../outside.html' },
        { id: 'other', file: 'screens/not-other.html' },
        { id: 'Bad_Id' },
        { id: 'home', title: 'Again' },
        { id: 'only-ghost', viewports: ['ghost'] },
        { id: 'long', description: 'x'.repeat(501) },
      ],
    };
    const { design, warnings } = normalizeDesign(raw, OPTS);
    assert.deepEqual(design.screens.map((s) => s.id), ['home', 'only-ghost', 'long']);
    assert.deepEqual(design.screens[0]?.viewports, ['laptop']);
    assert.equal(design.screens[1]?.viewports, undefined, 'all refs unknown → shows at every viewport');
    assert.equal(design.screens[2]?.description, undefined);
    assert.deepEqual(codes(warnings), [
      'unknown-screen-viewport',
      'invalid-screen-file',
      'invalid-screen-file',
      'invalid-screen',
      'duplicate-screen',
      'unknown-screen-viewport',
      'invalid-screen-description',
    ]);
  });

  test('more than 40 screens keeps the first 40', () => {
    const screens = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}` }));
    const { design, warnings } = normalizeDesign({ kind: 'canvas', title: 'X', screens }, OPTS);
    assert.equal(design.screens.length, 40);
    assert.deepEqual(codes(warnings), ['too-many-screens']);
  });

  test('an artifact ignores a screen list, and its entry cannot be changed', () => {
    const { design, warnings } = normalizeDesign({ kind: 'artifact', title: 'X', entry: '../evil.html', screens: [{ id: 'a' }] }, OPTS);
    assert.equal(design.entry, 'index.html');
    assert.deepEqual(design.screens, []);
    assert.deepEqual(codes(warnings).sort(), ['invalid-entry', 'screens-ignored']);
  });

  test('scalar fields: bad title, dates, ids, preset and designSystem fall back with warnings', () => {
    const raw = {
      kind: 'canvas',
      title: '   ',
      created: 'yesterday',
      updated: 42,
      brief: 7,
      sessionId: '',
      projectDirectory: { path: 'x' },
      preset: 'Not A Preset',
      designSystem: { confirmed: 'yes' },
    };
    const { design, warnings } = normalizeDesign(raw, OPTS);
    assert.equal(design.title, 'my-slug');
    assert.equal(design.created, OPTS.fallbackTime);
    assert.equal(design.updated, OPTS.fallbackTime);
    assert.equal(design.brief, '');
    assert.equal(design.sessionId, null);
    assert.equal(design.projectDirectory, null);
    assert.equal(design.preset, null);
    assert.deepEqual(design.designSystem, { confirmed: false });
    assert.deepEqual(codes(warnings).sort(), [
      'invalid-brief',
      'invalid-created',
      'invalid-design-system',
      'invalid-preset',
      'invalid-projectDirectory',
      'invalid-sessionId',
      'invalid-title',
      'invalid-updated',
    ]);
  });

  test('a title over 120 characters is dropped; one of exactly 120 is kept', () => {
    assert.equal(normalizeDesign({ kind: 'artifact', title: 'x'.repeat(120) }, OPTS).design.title.length, 120);
    const long = normalizeDesign({ kind: 'artifact', title: 'x'.repeat(121) }, OPTS);
    assert.equal(long.design.title, 'my-slug');
    assert.deepEqual(codes(long.warnings), ['invalid-title']);
  });

  test('a brief over 2000 characters is truncated with a warning', () => {
    const { design, warnings } = normalizeDesign({ kind: 'artifact', title: 'X', brief: 'b'.repeat(2500) }, OPTS);
    assert.equal(design.brief.length, 2000);
    assert.deepEqual(codes(warnings), ['brief-truncated']);
  });

  test('damaged and duplicate comments are dropped', () => {
    const raw = {
      kind: 'canvas',
      title: 'X',
      comments: [comment('c_aaaa1'), comment('c_aaaa1'), comment('nope'), comment('c_bbbb2', { body: '' }), comment('c_cccc3', { status: 'archived' })],
    };
    const { design, warnings } = normalizeDesign(raw, OPTS);
    assert.deepEqual(design.comments.map((c) => c.id), ['c_aaaa1']);
    assert.deepEqual(codes(warnings), ['invalid-comment', 'invalid-comment', 'invalid-comment', 'invalid-comment']);
  });

  test('missing or invalid kind is inferred from screens, and an authoritative kind wins', () => {
    const inferred = normalizeDesign({ title: 'X', screens: [{ id: 'a' }] }, OPTS);
    assert.equal(inferred.design.kind, 'canvas');
    assert.deepEqual(codes(inferred.warnings), ['invalid-kind']);
    assert.equal(normalizeDesign({ title: 'X', kind: 'poster' }, OPTS).design.kind, 'artifact');
    const forced = normalizeDesign({ kind: 'artifact', title: 'X', screens: [{ id: 'a' }] }, { ...OPTS, kind: 'canvas' });
    assert.equal(forced.design.kind, 'canvas');
    assert.deepEqual(forced.design.screens.map((s) => s.id), ['a']);
  });

  test('a future version warns but still reads', () => {
    const { design, warnings } = normalizeDesign({ ...validCanvas(), version: 2 }, OPTS);
    assert.equal(design.title, 'Checkout redesign');
    assert.deepEqual(codes(warnings), ['unsupported-version']);
  });

  test('non-object JSON and broken JSON give defaults, never throw', () => {
    for (const text of ['[1,2]', '"x"', 'null', '{"kind":', '']) {
      const parsed = parseDesignJsonText(text, OPTS);
      assert.equal(parsed.raw, null, text);
      assert.equal(parsed.design.title, 'my-slug');
      assert.ok(parsed.warnings.length > 0);
    }
    assert.equal(parseDesignJsonText('{"kind":', OPTS).warnings[0]?.code, 'invalid-json');
  });

  test('a UTF-8 BOM is tolerated', () => {
    const parsed = parseDesignJsonText(`\uFEFF${JSON.stringify({ kind: 'artifact', title: 'Bom' })}`, OPTS);
    assert.equal(parsed.design.title, 'Bom');
    assert.notEqual(parsed.raw, null);
  });
});

describe('parseComment', () => {
  test('accepts a valid comment and tolerates missing sentAt/sentVersion', () => {
    const { sentAt: _a, sentVersion: _b, ...rest } = comment('c_abcd1');
    const parsed = parseComment(rest);
    assert.equal(parsed?.sentAt, null);
    assert.equal(parsed?.sentVersion, null);
  });

  test('rejects out-of-range anchors and bodies', () => {
    const anchor = (patch: JsonObject): JsonObject => ({ ...(comment('c_abcd1').anchor as JsonObject), ...patch });
    assert.equal(parseComment(comment('c_abcd1', { anchor: anchor({ point: { x: 1.5, y: 0 } }) })), null);
    assert.equal(parseComment(comment('c_abcd1', { anchor: anchor({ text: 't'.repeat(121) }) })), null);
    assert.equal(parseComment(comment('c_abcd1', { anchor: anchor({ html: 'h'.repeat(201) }) })), null);
    assert.equal(parseComment(comment('c_abcd1', { anchor: anchor({ rect: { x: 0, y: 0, w: -1, h: 1 } }) })), null);
    assert.equal(parseComment(comment('c_abcd1', { body: 'b'.repeat(2001) })), null);
    assert.equal(parseComment(comment('c_abcd1', { sentVersion: 0 })), null);
    assert.notEqual(parseComment(comment('c_abcd1', { body: 'b'.repeat(2000), screen: null })), null);
  });
});

describe('service-owned fields (state.json authority, §6.3)', () => {
  const state: ServiceState = {
    version: 1,
    kind: 'canvas',
    created: T0,
    brief: 'brief',
    sessionId: 'ses_1',
    projectDirectory: null,
    preset: null,
    entry: null,
    comments: [],
  };

  test('mergeServiceFields restores service fields and keeps agent fields, unknown keys and key order', () => {
    const agentWrite: JsonObject = {
      title: 'Agent title',
      $custom: { keep: true },
      kind: 'artifact',
      updated: T1,
      viewports: 'broken but the agent’s',
      sessionId: 'ses_forged',
    };
    const merged = mergeServiceFields(agentWrite, state);
    assert.deepEqual(Object.keys(merged), ['title', '$custom', 'kind', 'updated', 'viewports', 'sessionId', 'version', 'created', 'brief', 'projectDirectory', 'preset', 'comments']);
    assert.equal(merged.kind, 'canvas');
    assert.equal(merged.sessionId, 'ses_1');
    assert.equal(merged.title, 'Agent title');
    assert.equal(merged.viewports, 'broken but the agent’s');
    assert.deepEqual(merged.$custom, { keep: true });
    assert.equal(Object.hasOwn(merged, 'entry'), false, 'a canvas has no entry');
  });

  test('an agent overwrite that lost the comments is detected and re-merged', () => {
    const withComments: ServiceState = { ...state, comments: [parseComment(comment('c_keep1')) ?? assert.fail('fixture')] };
    const agentWrite: JsonObject = { ...(createDesignDocument({ ...withComments, title: 'T', now: T0 }).json) };
    delete agentWrite.comments;
    assert.equal(serviceFieldsDiffer(agentWrite, withComments), true);
    const merged = mergeServiceFields(agentWrite, withComments);
    assert.equal(serviceFieldsDiffer(merged, withComments), false);
    assert.equal((merged.comments as JsonObject[])[0]?.id, 'c_keep1');
  });

  test('a merge of an already merged file is byte-identical (no watch loop)', () => {
    const once = serializeJson(mergeServiceFields({ title: 'X', extra: 1 }, state));
    const twice = serializeJson(mergeServiceFields(JSON.parse(once) as JsonObject, state));
    assert.equal(twice, once);
  });

  test('service writes may set title and updated', () => {
    const merged = mergeServiceFields({ title: 'Old', updated: T0 }, state, { title: 'Renamed', updated: T1 });
    assert.equal(merged.title, 'Renamed');
    assert.equal(merged.updated, T1);
  });

  test('createDesignDocument writes canonical order and reads back cleanly', () => {
    const artifact = createDesignDocument({ kind: 'artifact', title: 'Pricing', brief: 'b', sessionId: null, projectDirectory: null, preset: null, now: T0 });
    assert.deepEqual(Object.keys(artifact.json), ['version', 'kind', 'title', 'created', 'updated', 'brief', 'sessionId', 'projectDirectory', 'preset', 'entry', 'viewports', 'designSystem', 'comments']);
    const reread = normalizeDesign(artifact.json, OPTS);
    assert.deepEqual(reread.warnings, []);
    assert.equal(reread.design.entry, 'index.html');
    const canvas = createDesignDocument({ kind: 'canvas', title: 'Wall', brief: '', sessionId: 's', projectDirectory: 'C:\\p', preset: 'editorial', now: T0 });
    assert.deepEqual(canvas.json.screens, []);
    assert.equal(Object.hasOwn(canvas.json, 'entry'), false);
    assert.deepEqual(serviceStateOf(normalizeDesign(canvas.json, OPTS).design), canvas.state);
  });

  test('normalizeServiceState accepts a valid state and rejects a damaged one', () => {
    assert.deepEqual(normalizeServiceState(state), state);
    assert.equal(normalizeServiceState({ ...state, version: 2 }), null);
    assert.equal(normalizeServiceState({ ...state, kind: 'x' }), null);
    assert.equal(normalizeServiceState({ ...state, created: 'nope' }), null);
    assert.equal(normalizeServiceState('{}'), null);
  });

  test('applyServiceState overlays state onto the agent view', () => {
    const { design } = normalizeDesign({ ...validCanvas(), sessionId: 'ses_forged', comments: [] }, OPTS);
    const view = applyServiceState(design, state);
    assert.equal(view.sessionId, 'ses_1');
    assert.equal(view.title, 'Checkout redesign');
    assert.deepEqual(view.comments, []);
  });

  test('stripForVersion removes comments only', () => {
    assert.deepEqual(stripForVersion({ title: 'X', comments: [], other: 1 }), { title: 'X', other: 1 });
  });
});
