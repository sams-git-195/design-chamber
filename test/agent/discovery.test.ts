import assert from 'node:assert/strict';
import { mkdir, symlink } from 'node:fs/promises';
import { describe, test, type TestContext } from 'node:test';

import type { ProjectBreakpoint } from '../../src/shared/agent/context.ts';
import {
  designHeadings,
  discoverProjectRules,
  parseMediaBreakpoints,
  parseTailwindScreens,
  parseThemeBreakpoints,
  rootVarCount,
  suggestViewports,
  withDeadline,
} from '../../src/service/discovery.ts';
import { DISCOVERY_SOURCES_MAX } from '../../src/shared/limits.ts';
import { useTmpRoot } from '../helpers/tmp-root.ts';

/** A project folder fixture inside a tmp dir. */
const project = async (t: TestContext, files: Record<string, string>) => {
  const tmp = await useTmpRoot(t, 'dc-disc-');
  for (const [file, content] of Object.entries(files)) await tmp.write(file, content);
  return tmp.root;
};

const paths = (rules: { sources: { path: string }[] }): string[] => rules.sources.map((source) => source.path);

const rootBlock = (count: number): string => `:root {\n${Array.from({ length: count }, (_, i) => `  --token-${i}: ${i}px;`).join('\n')}\n}\n`;

describe('design documents', () => {
  test('finds DESIGN.md (any depth), docs/design*.md, design/*.md, style guide and brand notes, case-insensitively', async (t) => {
    const root = await project(t, {
      'DESIGN.md': '# d',
      'docs/Design-System.md': '# d',
      'design/colors.md': '# d',
      'STYLEGUIDE.md': '# d',
      'Brand-Voice.md': '# d',
      'docs/brand.md': '# d',
      'apps/web/design.md': '# d',
      // Not design documents:
      'README.md': '# readme',
      'docs/readme.md': '# docs',
      'notes/design.txt': 'x',
      'src/design/Button.tsx': 'x',
    });
    const rules = await discoverProjectRules(root);
    assert.equal(rules.state, 'scanned');
    assert.deepEqual(
      paths(rules).sort(),
      ['DESIGN.md', 'docs/Design-System.md', 'design/colors.md', 'STYLEGUIDE.md', 'Brand-Voice.md', 'docs/brand.md', 'apps/web/design.md'].sort(),
    );
    assert.ok(rules.sources.every((source) => source.kind === 'design-doc'));
  });

  test('shallower files come first', async (t) => {
    const root = await project(t, { 'a/b/DESIGN.md': '#', 'DESIGN.md': '#', 'a/DESIGN.md': '#' });
    assert.deepEqual(paths(await discoverProjectRules(root)), ['DESIGN.md', 'a/DESIGN.md', 'a/b/DESIGN.md']);
  });
});

describe('tokens and theme files', () => {
  test('finds token and theme files by name and CSS by content, in that order', async (t) => {
    const root = await project(t, {
      'tokens.css': ':root{}',
      'src/design-tokens.json': '{}',
      'tokens.studio.json': '{}',
      'src/theme.ts': 'export const theme = {}',
      'src/styles/theme.css': ':root{}',
      'tailwind.config.ts': 'export default { theme: { extend: {} } }',
      'src/styles/globals.css': rootBlock(6),
      'src/styles/app.css': '@import "tailwindcss";\n@theme {\n  --color-brand: #0f766e;\n}\n',
      // Not token sources:
      'src/styles/small.css': rootBlock(4),
      'package.json': '{"name":"x"}',
      'src/theming.ts': 'x',
    });
    const rules = await discoverProjectRules(root);
    assert.deepEqual(paths(rules), [
      'tokens.css',
      'tokens.studio.json',
      'src/design-tokens.json',
      'src/theme.ts',
      'src/styles/theme.css',
      'tailwind.config.ts',
      'src/styles/app.css',
      'src/styles/globals.css',
    ]);
    const why = Object.fromEntries(rules.sources.map((source) => [source.path, source.why]));
    assert.equal(why['src/styles/globals.css'], ':root defines 6 custom properties');
    assert.equal(why['src/styles/app.css'], 'Tailwind @theme block');
    assert.ok(rules.sources.every((source) => source.kind === 'tokens'));
  });

  test('a :root block needs at least five custom properties', () => {
    assert.equal(rootVarCount(rootBlock(5)), 5);
    assert.equal(rootVarCount(rootBlock(4)), 4);
    assert.equal(rootVarCount('/* :root { --a:1; --b:2; --c:3; --d:4; --e:5; --f:6 } */ body{}'), 0);
    assert.equal(rootVarCount('a{} :root{--a:1} .dark :root{--b:1;--c:2}'), 2);
  });
});

describe('agent files', () => {
  const WITH_DESIGN = ['# Project', '', '## Build and test', 'npm test', '', '## Design system', 'Use the teal accent.', '', '### UI conventions', '- cards', ''].join('\n');
  const WITHOUT_DESIGN = ['# Project', '', '## Build and test', 'npm test', '', '## Guidelines', 'Quick start for builders', '', '## Release notes', ''].join('\n');

  test('AGENTS.md / CLAUDE.md count only with a design heading, and the headings are recorded', async (t) => {
    const root = await project(t, { 'AGENTS.md': WITH_DESIGN, 'CLAUDE.md': WITHOUT_DESIGN });
    const rules = await discoverProjectRules(root);
    assert.deepEqual(paths(rules), ['AGENTS.md']);
    const [agents] = rules.sources;
    assert.equal(agents?.kind, 'agent-rules');
    assert.deepEqual(agents?.headings, ['Design system', 'UI conventions']);
    assert.equal(agents?.why, 'design sections: "Design system"; "UI conventions"');
  });

  test('"Build", "Guidelines" and "Quick start" are not design headings; UI, UX, Styling, Brand colours are', () => {
    assert.deepEqual(designHeadings('## Build and test\n## Guidelines\n## Quick start\n## Requirements\n## Suite'), []);
    assert.deepEqual(designHeadings('# UI\n## UX notes\n## Styling\n## Brand colours\n## Theming\n## Typography'), ['UI', 'UX notes', 'Styling', 'Brand colours', 'Theming', 'Typography']);
    assert.deepEqual(designHeadings('## Visual language\n## Colors'), ['Visual language', 'Colors']);
    assert.equal(designHeadings('# UI\n## UX\n## Styling\n## Brand\n## Theme\n## Typography\n## Colors\n## Visual').length, 6, 'capped at six');
  });

  test('headings inside code fences are ignored; duplicates collapse; at most six are kept', () => {
    assert.deepEqual(designHeadings('```md\n# Design inside a fence\n```\n~~~\n## UI inside tildes\n~~~\n## Design\n## Design\n'), ['Design']);
  });

  test('.github/copilot-instructions.md and .cursor/rules/* are read; other hidden folders and nested AGENTS.md too where allowed', async (t) => {
    const root = await project(t, {
      '.github/copilot-instructions.md': '## UI style\nx',
      '.cursor/rules/frontend.mdc': '# Design tokens\nx',
      '.cursor/rules/nested/skip.mdc': '# Design\nx',
      '.idea/AGENTS.md': '# Design\nx',
      'packages/web/AGENTS.md': '## Brand\nx',
    });
    assert.deepEqual(paths(await discoverProjectRules(root)), ['.github/copilot-instructions.md', '.cursor/rules/frontend.mdc', 'packages/web/AGENTS.md']);
  });
});

describe('priority and caps', () => {
  test('design docs, then tokens/theme, then agent files', async (t) => {
    const root = await project(t, { 'AGENTS.md': '## Design\nx', 'tokens.css': ':root{}', 'docs/DESIGN.md': '#' });
    assert.deepEqual(paths(await discoverProjectRules(root)), ['docs/DESIGN.md', 'tokens.css', 'AGENTS.md']);
  });

  test('keeps at most 20 sources and counts the rest', async (t) => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 25; i += 1) files[`pkg-${String(i).padStart(2, '0')}/DESIGN.md`] = '#';
    files['AGENTS.md'] = '## Design\nx';
    const rules = await discoverProjectRules(await project(t, files));
    assert.equal(rules.sources.length, DISCOVERY_SOURCES_MAX);
    assert.equal(rules.sourcesOmitted, 6);
    assert.ok(!paths(rules).includes('AGENTS.md'), 'lower-priority sources are the ones cut');
  });
});

describe('what is skipped', () => {
  test('never looks inside node_modules, .git, dist, build, out, .next, coverage, vendor, .venv', async (t) => {
    const skipped = ['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '.venv'];
    const files: Record<string, string> = { 'DESIGN.md': '#' };
    for (const dir of skipped) {
      files[`${dir}/DESIGN.md`] = '#';
      files[`${dir}/tokens.css`] = ':root{}';
      files[`${dir}/AGENTS.md`] = '## Design\nx';
    }
    files['NODE_MODULES/x/DESIGN.md'] = '#';
    const rules = await discoverProjectRules(await project(t, files));
    assert.deepEqual(paths(rules), ['DESIGN.md']);
  });

  test('folders deeper than 4 levels are not entered', async (t) => {
    const root = await project(t, { 'a/b/c/d/DESIGN.md': '#', 'a/b/c/d/e/DESIGN.md': '#' });
    assert.deepEqual(paths(await discoverProjectRules(root)), ['a/b/c/d/DESIGN.md']);
  });

  test('does not follow symlinked folders', async (t) => {
    const root = await project(t, { 'real/DESIGN.md': '#' });
    const elsewhere = await useTmpRoot(t, 'dc-disc-outside-');
    await elsewhere.write('DESIGN.md', '#');
    try {
      await symlink(elsewhere.root, `${root}/link`, 'junction');
    } catch (error) {
      t.skip(`cannot create a link here: ${(error as NodeJS.ErrnoException).code}`);
      return;
    }
    await mkdir(`${root}/plain`, { recursive: true });
    assert.deepEqual(paths(await discoverProjectRules(root)), ['real/DESIGN.md']);
  });
});

describe('time and size caps', () => {
  test('stops after the entry cap and says so', async (t) => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 30; i += 1) files[`f${String(i).padStart(2, '0')}.txt`] = 'x';
    files['DESIGN.md'] = '#';
    const rules = await discoverProjectRules(await project(t, files), { limits: { entries: 10 } });
    assert.equal(rules.truncated, true);
    assert.equal(rules.state, 'scanned');
  });

  test('stops at the time cap: an injected clock that jumps past 1.5 s ends the walk with what it has', async (t) => {
    const root = await project(t, { 'DESIGN.md': '#', 'a/b/DESIGN.md': '#', 'a/tokens.css': ':root{}' });
    let calls = 0;
    // The first reading is the start time; every later one is 2 s further on.
    const now = (): number => (calls++ === 0 ? 0 : 2000);
    const rules = await discoverProjectRules(root, { now });
    assert.equal(rules.truncated, true);
    assert.deepEqual(rules.sources, []);
  });

  test('a time cap that strikes after the walk still returns the documents already found', async (t) => {
    const root = await project(t, { 'DESIGN.md': '#', 'tailwind.config.ts': 'export default {}', 'src/a.css': '@media (min-width: 768px){}' });
    let calls = 0;
    // Start, then the walk's check for the root folder pass; every check after that is over the cap.
    const now = (): number => (calls++ < 2 ? 0 : 5000);
    const rules = await discoverProjectRules(root, { now });
    assert.equal(rules.truncated, true);
    assert.ok(paths(rules).includes('DESIGN.md'));
  });

  test('reads at most the CSS file limit, shallowest first, and flags it', async (t) => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i += 1) files[`s${i}/x.css`] = rootBlock(6);
    files['x.css'] = rootBlock(6);
    const rules = await discoverProjectRules(await project(t, files), { limits: { cssFiles: 3 } });
    assert.equal(rules.truncated, true);
    assert.equal(rules.sources.length, 3);
    assert.equal(rules.sources[0]?.path, 'x.css');
  });
});

describe('withDeadline', () => {
  test('answers the fallback when the scan hangs, the scan\'s answer when it is quick, and passes errors through', async () => {
    assert.equal(await withDeadline(new Promise<string>(() => undefined), 20, 'late'), 'late');
    assert.equal(await withDeadline(Promise.resolve('fast'), 1000, 'late'), 'fast');
    await assert.rejects(withDeadline(Promise.reject(new Error('boom')), 1000, 'late'), /boom/);
  });
});

describe('no project, unreadable project', () => {
  test('nothing given, relative path, filesystem root', async () => {
    for (const input of [null, undefined, '', '  ']) assert.equal((await discoverProjectRules(input)).state, 'no-project');
    const relative = await discoverProjectRules('some/dir');
    assert.equal(relative.state, 'no-project');
    assert.match(relative.note ?? '', /not absolute/);
    const root = process.platform === 'win32' ? 'C:\\' : '/';
    assert.match((await discoverProjectRules(root)).note ?? '', /root/);
  });

  test('a chat inside the Designs folder has no project', async (t) => {
    const designs = await useTmpRoot(t, 'dc-disc-designs-');
    await designs.write('my-design/DESIGN.md', '#');
    const rules = await discoverProjectRules(designs.at('my-design'), { designsRoot: designs.root });
    assert.equal(rules.state, 'no-project');
    assert.match(rules.note ?? '', /Designs folder/);
    assert.equal((await discoverProjectRules(designs.root, { designsRoot: designs.root })).state, 'no-project');
  });

  test('a missing folder and a plain file are unreadable, with a reason', async (t) => {
    const tmp = await useTmpRoot(t, 'dc-disc-');
    await tmp.write('file.txt', 'x');
    const missing = await discoverProjectRules(tmp.at('nope'));
    assert.equal(missing.state, 'unreadable');
    assert.equal(missing.note, 'the folder does not exist');
    const file = await discoverProjectRules(tmp.at('file.txt'));
    assert.equal(file.state, 'unreadable');
    assert.equal(file.note, 'it is not a folder');
  });

  test('an empty project scans cleanly with no sources', async (t) => {
    const rules = await discoverProjectRules(await project(t, { 'src/index.ts': 'x' }));
    assert.equal(rules.state, 'scanned');
    assert.deepEqual(rules.sources, []);
    assert.deepEqual(rules.viewports, []);
    assert.equal(rules.truncated, false);
  });
});

describe('Tailwind screens', () => {
  test('parses screens in px, rem and em, quoted or bare keys, extend.screens and nested min/max', () => {
    const { found, screens } = parseTailwindScreens(`
      export default {
        theme: {
          screens: { sm: '640px', 'md': "48rem", "2xl": '96em', tall: { raw: '(min-height: 800px)' } },
          extend: { screens: { xs: '475px', band: { min: '800px', max: '1100px' } } },
        },
      }`);
    assert.equal(found, true);
    assert.deepEqual(screens, [
      { name: 'sm', px: 640, direction: 'min' },
      { name: 'md', px: 768, direction: 'min' },
      { name: '2xl', px: 1536, direction: 'min' },
      { name: 'xs', px: 475, direction: 'min' },
      { px: 800, direction: 'min' },
      { px: 1100, direction: 'max' },
    ]);
  });

  test('no screens key → found is false', () => {
    assert.deepEqual(parseTailwindScreens('export default { theme: { extend: { colors: {} } } }'), { found: false, screens: [] });
  });

  test('Tailwind v4 --breakpoint-* custom properties', () => {
    assert.deepEqual(parseThemeBreakpoints('@theme { --breakpoint-3xl: 120rem; --breakpoint-md: 700px; --color-x: red; } /* --breakpoint-xs: 300px */'), [
      { name: '3xl', px: 1920, direction: 'min' },
      { name: 'md', px: 700, direction: 'min' },
    ]);
  });

  test('a config with screens makes those breakpoints; without screens the stock ones apply', async (t) => {
    const custom = await discoverProjectRules(await project(t, { 'tailwind.config.js': "module.exports = { theme: { screens: { sm: '480px', lg: '1100px' } } }" }));
    assert.deepEqual(custom.breakpoints.map((b) => [b.px, b.name, b.origin]), [[480, 'sm', 'tailwind'], [1100, 'lg', 'tailwind']]);
    assert.equal(custom.sources[0]?.why, 'Tailwind config (screens: sm 480 · lg 1100)');
    assert.deepEqual(custom.viewports.map((v) => v.id), ['phone', 'laptop']);

    const stock = await discoverProjectRules(await project(t, { 'tailwind.config.ts': 'export default { content: [] }' }));
    assert.deepEqual(stock.breakpoints.map((b) => [b.px, b.origin]), [[640, 'tailwind-default'], [768, 'tailwind-default'], [1024, 'tailwind-default'], [1280, 'tailwind-default'], [1536, 'tailwind-default']]);
    assert.match(stock.sources[0]?.why ?? '', /stock breakpoints apply/);
    assert.deepEqual(stock.viewports.map((v) => v.id), ['phone', 'tablet', 'laptop']);
  });
});

describe('@media frequencies → breakpoints → viewports', () => {
  test('parses min/max-width in px, em and rem, range syntax, several conditions per rule; ignores comments and other features', () => {
    const found = parseMediaBreakpoints(`
      /* @media (min-width: 999px) { } */
      @media (min-width: 768px) { a { color: red } }
      @media screen and (max-width: 47.9375em) and (min-width: 20rem) { }
      @media (width >= 1024px) { }
      @media (width < 600px) { }
      @media (prefers-reduced-motion: reduce) { }
      @media print { }
      @media (min-width: 10px) { }
    `);
    assert.deepEqual(found, [
      { px: 768, direction: 'min' },
      { px: 767, direction: 'max' },
      { px: 320, direction: 'min' },
      { px: 1024, direction: 'min' },
      { px: 600, direction: 'max' },
    ]);
  });

  test('the four most frequent values across all CSS files become breakpoints, most frequent first by count then size', async (t) => {
    const media = (widths: number[], dir = 'min'): string => widths.map((w) => `@media (${dir}-width: ${w}px) { .a { color: red } }`).join('\n');
    const root = await project(t, {
      'src/a.css': media([768, 768, 768, 1024, 1024, 480, 1280, 1536]),
      'src/b.scss': media([768, 1024, 640]),
      'src/c.css': media([480], 'max'),
    });
    const rules = await discoverProjectRules(root);
    // Counts: 768×4, 1024×3, 480×2 (min+max), then 640/1280/1536 tie at 1 → the smallest, 640, wins the fourth place.
    assert.deepEqual(rules.breakpoints.map((b) => [b.px, b.count, b.origin]), [[480, 2, 'css'], [640, 1, 'css'], [768, 4, 'css'], [1024, 3, 'css']]);
    assert.deepEqual(rules.breakpoints.find((b) => b.px === 480)?.directions.sort(), ['max', 'min']);
    assert.deepEqual(rules.viewports.map((v) => v.id), ['phone', 'tablet', 'laptop']);
  });

  test('breakpoint classes follow the spec: ≤ 480 phone, ≤ 1024 tablet, above laptop (desktop from 1440)', () => {
    const bp = (px: number, direction: 'min' | 'max'): ProjectBreakpoint => ({ px, directions: [direction], origin: 'css', count: 1 });
    // max-width breakpoints only: desktop-first, so the laptop is implied as well.
    assert.deepEqual(suggestViewports([bp(480, 'max')]).map((v) => v.id), ['phone', 'laptop']);
    assert.deepEqual(suggestViewports([bp(768, 'max'), bp(1024, 'max')]).map((v) => v.id), ['tablet', 'laptop']);
    // min-width: mobile-first, so the phone is implied.
    assert.deepEqual(suggestViewports([bp(768, 'min')]).map((v) => v.id), ['phone', 'tablet']);
    assert.deepEqual(suggestViewports([bp(1280, 'min')]).map((v) => v.id), ['phone', 'laptop']);
    assert.deepEqual(suggestViewports([bp(1600, 'min')]).map((v) => v.id), ['phone', 'desktop']);
    assert.deepEqual(suggestViewports([bp(1280, 'min'), bp(1600, 'min')]).map((v) => v.id), ['phone', 'laptop'], 'desktop is dropped when a laptop is suggested');
    assert.deepEqual(suggestViewports([]), []);
    assert.deepEqual(suggestViewports([bp(480, 'max')])[0], { id: 'phone', label: 'Phone', width: 390, height: 844 });
    assert.deepEqual(suggestViewports([bp(768, 'min')])[1], { id: 'tablet', label: 'Tablet', width: 768, height: 1024 });
  });

  test('a Tailwind screen and a CSS @media at the same width merge into one breakpoint', async (t) => {
    const root = await project(t, {
      'tailwind.config.js': "module.exports = { theme: { screens: { md: '768px' } } }",
      'a.css': '@media (max-width: 768px) {}\n@media (max-width: 768px) {}',
    });
    const rules = await discoverProjectRules(root);
    assert.equal(rules.breakpoints.length, 1);
    assert.deepEqual(rules.breakpoints[0], { px: 768, directions: ['min', 'max'], origin: 'tailwind', count: 3, name: 'md' });
  });
});
