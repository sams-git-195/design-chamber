import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { buildChip, buildChipText, titleFromBrief } from '../../src/shared/agent/chip.ts';
import { rulesPathOf, type ProjectRules, type ProjectSource } from '../../src/shared/agent/context.ts';
import { BRIEF_MAX, CHIP_PROJECT_PATHS_MAX, CHIP_TEXT_HARD_MAX, CHIP_TEXT_TARGET, HOST_ATTACH_ID_MAX, HOST_ATTACH_TITLE_MAX, HOST_ATTACH_URL_MAX, HOST_TEXT_MAX } from '../../src/shared/limits.ts';
import { baseContext } from './helpers.ts';
import { assertSnapshot } from './snapshot.ts';

const scanned = (sources: ProjectSource[], extra: Partial<ProjectRules> = {}): ProjectRules => ({
  state: 'scanned',
  directory: 'C:\\Users\\you\\code\\beans',
  note: null,
  sources,
  sourcesOmitted: 0,
  breakpoints: [],
  viewports: [],
  truncated: false,
  ...extra,
});

const source = (file: string, kind: ProjectSource['kind'] = 'design-doc'): ProjectSource => ({ path: file, kind, why: 'a reason' });

const BEANS = scanned(
  [
    source('DESIGN.md'),
    { path: 'tailwind.config.ts', kind: 'tokens', why: 'Tailwind config (screens: sm 640 · md 768 · lg 1024)' },
    { path: 'AGENTS.md', kind: 'agent-rules', why: 'design sections: "Design system"', headings: ['Design system'] },
  ],
  {
    breakpoints: [
      { px: 640, directions: ['min'], origin: 'tailwind', count: 1, name: 'sm' },
      { px: 768, directions: ['min'], origin: 'tailwind', count: 1, name: 'md' },
      { px: 1024, directions: ['min'], origin: 'tailwind', count: 1, name: 'lg' },
    ],
    viewports: [
      { id: 'phone', label: 'Phone', width: 390, height: 844 },
      { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
      { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
    ],
  },
);

describe('chip core text', () => {
  test('tells the agent what to read first, where to look, when to ask and what to write', () => {
    const context = baseContext({ project: BEANS, preset: { id: 'minimal-saas', name: 'Minimal SaaS', text: '# Minimal SaaS' } });
    const text = buildChipText(context, 'new');

    assert.ok(text.startsWith('[Design Chamber] New canvas: "Pricing page for a coffee subscription"'));
    assert.ok(text.includes(`Write ONLY inside this folder: ${context.folder}`));

    // The order is the point: rules file first, then the project's own rules, then precedence, viewports, questions.
    const at = (needle: string): number => {
      const index = text.indexOf(needle);
      assert.ok(index >= 0, `missing: ${needle}`);
      return index;
    };
    const order = [
      at(`FIRST read, in full: ${rulesPathOf(context.folder)}`),
      at("THEN look for the active project's own design rules before designing"),
      at('Precedence, highest first'),
      at('Viewports'),
      at('Unsure about anything material? Ask first'),
      at('Files you write'),
      at('design.json: you own title, updated, viewports, screens and designSystem'),
    ];
    assert.deepEqual(order, [...order].sort((a, b) => a - b));

    assert.ok(text.includes('DESIGN.md, tailwind.config.ts, AGENTS.md'));
    assert.ok(text.includes('style preset (Minimal SaaS)'));
    assert.ok(text.includes('3–6 short numbered questions'));
    assert.ok(text.includes('recommended default'));
    assert.ok(text.includes('screens/<id>.html'));
    assert.ok(text.includes("breakpoints (640, 768, 1024) suggest Phone 390×844, Tablet 768×1024, Laptop 1280×800"));
    assert.ok(text.includes('Never touch .versions/, .chamber/ or .thumb.png.'));
  });

  test('an artifact lists index.html, not screens', () => {
    const text = buildChipText(baseContext({ kind: 'artifact' }), 'new');
    assert.ok(text.includes('New artifact:'));
    assert.ok(text.includes('index.html (one self-contained page)'));
    assert.ok(!text.includes('screens/<id>.html'));
    assert.ok(text.includes('you own title, updated, viewports and designSystem'));
  });

  test('no project: says so and tells the agent to ask; defaults named', () => {
    const text = buildChipText(baseContext(), 'new');
    assert.ok(text.includes('No project folder is open in this chat (the chat has no project folder)'));
    assert.ok(text.includes('Ask the user whether an existing codebase or brand should be followed'));
    assert.ok(text.includes('The project gave no breakpoints, so ask which to show'));
    assert.ok(text.includes('Laptop 1280×800 + Phone 390×844'));
    assert.ok(text.includes('style preset (none chosen)'));
  });

  test('a scanned project with nothing found, and an unreadable one', () => {
    assert.ok(buildChipText(baseContext({ project: scanned([]) }), 'new').includes('found no design docs, token/theme files or design sections in C:\\Users\\you\\code\\beans'));
    const unreadable = scanned([], { state: 'unreadable', note: 'the folder does not exist' });
    assert.ok(buildChipText(baseContext({ project: unreadable }), 'new').includes('could not be read (the folder does not exist)'));
  });

  test('an empty brief tells the agent to ask what to design', () => {
    assert.ok(buildChipText(baseContext({ brief: '  ' }), 'new').includes('Brief: none — ask the user what to design.'));
  });

  test('lists at most CHIP_PROJECT_PATHS_MAX project paths and counts the rest', () => {
    const sources = Array.from({ length: 20 }, (_, i) => source(`docs/design-${String(i).padStart(2, '0')}.md`));
    const text = buildChipText(baseContext({ project: scanned(sources) }), 'new');
    for (let i = 0; i < CHIP_PROJECT_PATHS_MAX; i += 1) assert.ok(text.includes(`design-${String(i).padStart(2, '0')}.md`), `path ${i} listed`);
    assert.ok(!text.includes(`design-${String(CHIP_PROJECT_PATHS_MAX).padStart(2, '0')}.md`), 'the 7th path is not listed');
    assert.ok(text.includes(`(+${20 - CHIP_PROJECT_PATHS_MAX} more, listed in RULES.md)`));
  });

  test('stays far under the host cap with the largest inputs (brief 2 000, 20 sources, long paths)', () => {
    const longPath = (i: number): string => `packages/${'very-long-folder-name/'.repeat(8)}design-${i}.md`;
    const context = baseContext({
      title: 'T'.repeat(300),
      brief: 'b'.repeat(BRIEF_MAX + 500),
      folder: `C:\\Users\\${'u'.repeat(40)}\\Documents\\Designs\\${'s'.repeat(63)}`,
      project: scanned(Array.from({ length: 20 }, (_, i) => source(longPath(i))), {
        directory: `D:\\${'p'.repeat(400)}`,
        sourcesOmitted: 7,
        breakpoints: Array.from({ length: 10 }, (_, i) => ({ px: 400 + i * 100, directions: ['min' as const], origin: 'css' as const, count: 3 })),
        viewports: [
          { id: 'phone', label: 'Phone', width: 390, height: 844 },
          { id: 'tablet', label: 'Tablet', width: 768, height: 1024 },
          { id: 'laptop', label: 'Laptop', width: 1280, height: 800 },
        ],
      }),
      preset: { id: 'data-dense-dashboard', name: 'Data-Dense Dashboard', text: '' },
      screenIds: Array.from({ length: 40 }, (_, i) => `screen-number-${i}`),
      pending: false,
    });
    for (const mode of ['new', 'continue'] as const) {
      const { length } = buildChipText(context, mode);
      assert.ok(length <= CHIP_TEXT_HARD_MAX, `${mode}: ${length} > ${CHIP_TEXT_HARD_MAX}`);
      assert.ok(length <= HOST_TEXT_MAX);
    }
  });

  test('a 2 000-character brief with 20 project sources still fits the 5 000 target', () => {
    const sources = Array.from({ length: 20 }, (_, i) => source(`src/styles/design/tokens-${i}.css`));
    const text = buildChipText(baseContext({ brief: 'b'.repeat(BRIEF_MAX), project: scanned(sources) }), 'new');
    assert.ok(text.length <= CHIP_TEXT_TARGET, String(text.length));
  });

  test('a typical chip is short', () => {
    assert.ok(buildChipText(baseContext({ project: BEANS }), 'new').length < 3500);
  });

  test('continue mode reports the current state and keeps the design viewports', () => {
    const text = buildChipText(baseContext({ pending: false, screenIds: ['home', 'pricing'] }), 'continue');
    assert.ok(text.startsWith('[Design Chamber] Continue canvas:'));
    assert.ok(text.includes('State: 2 screens (home, pricing).'));
    assert.ok(text.includes('this design shows Laptop 1280×800, Phone 390×844'));
    assert.ok(text.includes("Brief (the user's words, original):"));
    assert.ok(buildChipText(baseContext(), 'continue').includes('State: nothing written yet.'));
    assert.ok(buildChipText(baseContext({ kind: 'artifact', pending: false }), 'continue').includes('State: index.html is written.'));
  });
});

describe('buildChip', () => {
  test('identity, data and file URL follow the contract', () => {
    const context = baseContext({ folder: 'C:\\Designs\\pricing-page' });
    const url = pathToFileURL(context.folder).href;
    const chip = buildChip(context, { slug: 'pricing-page', mode: 'new', folderUrl: url });
    assert.equal(chip.providerId, 'design-chamber');
    assert.equal(chip.id, 'design:pricing-page');
    assert.deepEqual(chip.data, { slug: 'pricing-page', kind: 'canvas' });
    assert.equal(chip.url, url);
    assert.equal(chip.text, buildChipText(context, 'new'));
    assert.ok(chip.id.length <= HOST_ATTACH_ID_MAX);
  });

  test('a file URL over the host cap is dropped; the title is capped', () => {
    const chip = buildChip(baseContext({ title: 'T'.repeat(400) }), { slug: 's', mode: 'new', folderUrl: `file:///${'x'.repeat(HOST_ATTACH_URL_MAX)}` });
    assert.equal(chip.url, '');
    assert.ok(chip.title.length <= HOST_ATTACH_TITLE_MAX);
  });
});

describe('titleFromBrief', () => {
  test('first sentence, capitalised, trailing punctuation dropped', () => {
    assert.equal(titleFromBrief('a pricing page for a coffee subscription. Three plans.', 'canvas'), 'A pricing page for a coffee subscription');
    assert.equal(titleFromBrief('Landing page: hero, pricing, FAQ', 'artifact'), 'Landing page');
  });

  test('long first lines are cut on a word boundary at 60 characters', () => {
    const title = titleFromBrief('Redesign the whole checkout flow for returning customers on small phones', 'canvas');
    assert.ok(title.length <= 60);
    assert.equal(title, 'Redesign the whole checkout flow for returning customers on');
  });

  test('uses the first non-empty line and falls back by kind', () => {
    assert.equal(titleFromBrief('\n\n  Pricing page\nmore', 'canvas'), 'Pricing page');
    assert.equal(titleFromBrief('', 'canvas'), 'New canvas');
    assert.equal(titleFromBrief('   ', 'artifact'), 'New artifact');
  });
});

describe('golden samples (what the agent receives)', () => {
  test('new canvas in a Tailwind project with a preset', async () => {
    await assertSnapshot('chip.new-canvas-project-preset.txt', buildChipText(baseContext({ project: BEANS, preset: { id: 'minimal-saas', name: 'Minimal SaaS', text: '' } }), 'new'));
  });

  test('new artifact without a project', async () => {
    await assertSnapshot('chip.new-artifact-no-project.txt', buildChipText(baseContext({ kind: 'artifact', title: 'Pricing page', folder: 'C:\\Users\\you\\Documents\\Designs\\pricing-page', brief: '' }), 'new'));
  });

  test('continue a canvas', async () => {
    await assertSnapshot('chip.continue-canvas.txt', buildChipText(baseContext({ pending: false, screenIds: ['home', 'pricing', 'checkout'], project: BEANS }), 'continue'));
  });
});
