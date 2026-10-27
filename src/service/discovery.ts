// Project-rules discovery (docs/SPEC.md §11.1): which design documents, token/theme files and
// agent-file design sections the chat's project already has, and which viewports its breakpoints
// suggest. Read-only and bounded (depth, entry count, files read, wall-clock), because the chat's
// folder may be anything — a monorepo, or the user's home directory. Only paths and headings leave
// this module: the agent reads the files itself.

import { open, readdir, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';

import {
  clip,
  noProject,
  oneLine,
  VIEWPORT_DESKTOP,
  VIEWPORT_TABLET,
  type ProjectBreakpoint,
  type ProjectRules,
  type ProjectSource,
} from '../shared/agent/context.ts';
import { VIEWPORT_LAPTOP, VIEWPORT_PHONE } from '../shared/design-json.ts';
import {
  DISCOVERY_BREAKPOINTS_MAX,
  DISCOVERY_DEPTH_MAX,
  DISCOVERY_ENTRIES_MAX,
  DISCOVERY_ROOT_VARS_MIN,
  DISCOVERY_SOURCES_MAX,
  DISCOVERY_TIME_MAX_MS,
} from '../shared/limits.ts';
import type { Viewport } from '../shared/types.ts';
import { isInsideOrEqual } from './paths.ts';

export type DiscoveryLimits = {
  /** Folder nesting below the project folder. */
  depth: number;
  /** Directory entries looked at in total. */
  entries: number;
  timeMs: number;
  /** Sources kept. */
  sources: number;
  /** CSS/SCSS files read (shallowest first). */
  cssFiles: number;
  /** AGENTS.md / CLAUDE.md / Copilot / Cursor files read. */
  agentFiles: number;
  /** Bytes read from the start of any one file. */
  fileBytes: number;
};

export const DEFAULT_DISCOVERY_LIMITS: Readonly<DiscoveryLimits> = Object.freeze({
  depth: DISCOVERY_DEPTH_MAX,
  entries: DISCOVERY_ENTRIES_MAX,
  timeMs: DISCOVERY_TIME_MAX_MS,
  sources: DISCOVERY_SOURCES_MAX,
  cssFiles: 40,
  agentFiles: 12,
  fileBytes: 200 * 1024,
});

export type DiscoveryOptions = {
  /** The designs root: a chat that runs inside it has no project. */
  designsRoot?: string;
  limits?: Partial<DiscoveryLimits>;
  /** Clock in ms; tests inject one to prove the time cap. */
  now?: () => number;
};

// ---- walking ----

const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'coverage', 'vendor', '.venv']);
/** Other hidden folders are skipped too, except the two that hold agent rules. */
const KEEP_HIDDEN_DIRS: ReadonlySet<string> = new Set(['.github', '.cursor']);

const shouldDescend = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (SKIP_DIRS.has(lower)) return false;
  return !lower.startsWith('.') || KEEP_HIDDEN_DIRS.has(lower);
};

type Walk = { files: string[]; truncated: boolean };

/** Breadth-first listing of files as `/`-separated relative paths. Symlinks are never followed. */
const walk = async (root: string, limits: DiscoveryLimits, expired: () => boolean): Promise<Walk> => {
  const files: string[] = [];
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: root, rel: '', depth: 0 }];
  let entries = 0;
  for (let index = 0; index < queue.length; index += 1) {
    const dir = queue[index];
    if (dir === undefined) break;
    if (expired()) return { files, truncated: true };
    const dirents = await readdir(dir.abs, { withFileTypes: true }).catch(() => null);
    if (dirents === null) continue;
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      entries += 1;
      if (entries > limits.entries) return { files, truncated: true };
      const rel = dir.rel === '' ? dirent.name : `${dir.rel}/${dirent.name}`;
      if (dirent.isDirectory()) {
        if (dir.depth < limits.depth && shouldDescend(dirent.name)) queue.push({ abs: path.join(dir.abs, dirent.name), rel, depth: dir.depth + 1 });
      } else if (dirent.isFile()) {
        files.push(rel);
      }
    }
  }
  return { files, truncated: false };
};

/** The first `maxBytes` of a file as text; `null` when it cannot be read. */
const readHead = async (file: string, maxBytes: number): Promise<string | null> => {
  let handle: FileHandle | undefined;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

// ---- classification (pure) ----

const depthOf = (relative: string): number => relative.split('/').length - 1;
const bySpot = (a: string, b: string): number => depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0);
const split = (relative: string): { dir: string; base: string } => {
  const lower = relative.toLowerCase();
  const slash = lower.lastIndexOf('/');
  return { dir: slash < 0 ? '' : lower.slice(0, slash), base: lower.slice(slash + 1) };
};

/** Design documents: DESIGN.md anywhere, `docs/design*.md`, `design/*.md`, style guide and brand notes. */
export const designDocWhy = (relative: string): string | null => {
  const { dir, base } = split(relative);
  if (base === 'design.md') return 'design document';
  if (dir === 'docs' && base.startsWith('design') && base.endsWith('.md')) return 'design document';
  if (dir === 'design' && base.endsWith('.md')) return 'design document';
  if ((dir === '' || dir === 'docs') && base === 'styleguide.md') return 'style guide';
  if ((dir === '' || dir === 'docs') && base.startsWith('brand') && base.endsWith('.md')) return 'brand guide';
  return null;
};

const TAILWIND_CONFIG = /^tailwind\.config\.(js|cjs|mjs|ts)$/;

/** Tokens and theme files recognised by name. */
export const tokenFileWhy = (relative: string): string | null => {
  const { base } = split(relative);
  if (base === 'tokens.css' || base.startsWith('design-tokens.') || (base.endsWith('.json') && base.includes('tokens'))) return 'design tokens';
  if (/^theme\.(css|ts|js|json)$/.test(base)) return 'theme file';
  if (TAILWIND_CONFIG.test(base)) return 'Tailwind config';
  return null;
};

const isStyleFile = (relative: string): boolean => /\.(css|scss)$/i.test(relative) && !/\.min\./i.test(relative);

/** Agent-instruction files whose design headings are worth reading. */
export const isAgentFile = (relative: string): boolean => {
  const { dir, base } = split(relative);
  if (base === 'agents.md' || base === 'claude.md') return true;
  if (dir === '.github' && base === 'copilot-instructions.md') return true;
  return dir === '.cursor/rules';
};

/**
 * Headings that mention design. Word-bounded on purpose: a bare `ui` substring would flag
 * "Build and test" and "Guidelines", which says nothing about design.
 */
const DESIGN_HEADING = /\b(?:design\w*|ui|ux|styl(?:e|es|ing)|brand\w*|them(?:e|es|ing)|visual\w*|typograph\w*|colou?rs?)\b/i;
const HEADINGS_MAX = 6;
const HEADING_SHOWN_MAX = 80;

/** Markdown headings (outside code fences) that mention design, tidied and capped. */
export const designHeadings = (markdown: string): string[] => {
  const found: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      const char = marker.charAt(0);
      fence = fence === null ? char : fence === char ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)?.[1];
    if (heading === undefined || !DESIGN_HEADING.test(heading)) continue;
    const shown = clip(oneLine(heading), HEADING_SHOWN_MAX);
    if (!found.includes(shown)) found.push(shown);
    if (found.length >= HEADINGS_MAX) break;
  }
  return found;
};

// ---- breakpoints (pure) ----

const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

const toPx = (value: string, unit: string): number => Math.round(Number(value) * (unit.toLowerCase() === 'px' ? 1 : 16));

const plausible = (px: number): boolean => Number.isFinite(px) && px >= 200 && px <= 4000;

export type MediaBreakpoint = { px: number; direction: 'min' | 'max' };

/** Every `min-width` / `max-width` condition of every `@media` rule in `css` (range syntax included). */
export const parseMediaBreakpoints = (css: string): MediaBreakpoint[] => {
  const found: MediaBreakpoint[] = [];
  for (const rule of stripComments(css).matchAll(/@media([^{;]*)\{/gi)) {
    const prelude = rule[1] ?? '';
    for (const match of prelude.matchAll(/\(\s*(min|max)-width\s*:\s*(\d+(?:\.\d+)?)\s*(px|em|rem)\s*\)/gi)) {
      const px = toPx(match[2] ?? '', match[3] ?? 'px');
      if (plausible(px)) found.push({ px, direction: (match[1] ?? '').toLowerCase() === 'max' ? 'max' : 'min' });
    }
    for (const match of prelude.matchAll(/\(\s*width\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s*(px|em|rem)\s*\)/gi)) {
      const px = toPx(match[2] ?? '', match[3] ?? 'px');
      if (plausible(px)) found.push({ px, direction: (match[1] ?? '').startsWith('>') ? 'min' : 'max' });
    }
  }
  return found;
};

/** The text between the `{` at `openIndex` and its matching `}`; `null` when unbalanced. */
const balancedBody = (text: string, openIndex: number): string | null => {
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, index);
    }
  }
  return null;
};

export type TailwindScreen = { name?: string; px: number; direction: 'min' | 'max' };

/** Tailwind `screens: { sm: '640px', … }` (also `theme.extend.screens`, and `{ min, max }` objects) in a config file. */
export const parseTailwindScreens = (source: string): { found: boolean; screens: TailwindScreen[] } => {
  const screens: TailwindScreen[] = [];
  let found = false;
  for (const key of source.matchAll(/\bscreens\s*:\s*\{/g)) {
    found = true;
    const body = balancedBody(source, key.index + key[0].length - 1);
    if (body === null) continue;
    for (const pair of body.matchAll(/['"]?([\w.-]+)['"]?\s*:\s*['"`](\d+(?:\.\d+)?)\s*(px|rem|em)['"`]/g)) {
      const name = pair[1] ?? '';
      const px = toPx(pair[2] ?? '', pair[3] ?? 'px');
      if (!plausible(px)) continue;
      const nested = name === 'min' || name === 'max';
      screens.push({ ...(nested ? {} : { name }), px, direction: name === 'max' ? 'max' : 'min' });
    }
  }
  return { found, screens };
};

/** Tailwind v4 `--breakpoint-md: 48rem` custom properties. */
export const parseThemeBreakpoints = (css: string): TailwindScreen[] =>
  [...stripComments(css).matchAll(/--breakpoint-([\w-]+)\s*:\s*(\d+(?:\.\d+)?)\s*(px|rem|em)/g)]
    .map((match): TailwindScreen => ({ name: match[1] ?? '', px: toPx(match[2] ?? '', match[3] ?? 'px'), direction: 'min' }))
    .filter((screen) => plausible(screen.px));

const TAILWIND_DEFAULT_SCREENS: readonly TailwindScreen[] = [
  { name: 'sm', px: 640, direction: 'min' },
  { name: 'md', px: 768, direction: 'min' },
  { name: 'lg', px: 1024, direction: 'min' },
  { name: 'xl', px: 1280, direction: 'min' },
  { name: '2xl', px: 1536, direction: 'min' },
];

/** The most custom properties any one `:root { … }` block declares. */
export const rootVarCount = (css: string): number =>
  Math.max(0, ...[...stripComments(css).matchAll(/:root\s*\{([^}]*)\}/g)].map((block) => (block[1]?.match(/--[\w-]+\s*:/g) ?? []).length));

/**
 * Viewports the breakpoints suggest: ≤ 480 → phone, ≤ 1024 → tablet, above → laptop (desktop from
 * 1440). Beyond that rule: any `min-width` breakpoint means the base layout is mobile-first, so
 * the phone is in; any `max-width` one means desktop-first, so the laptop is in. Desktop is
 * dropped when a laptop is suggested.
 */
export const suggestViewports = (breakpoints: readonly ProjectBreakpoint[]): Viewport[] => {
  if (breakpoints.length === 0) return [];
  const want = new Set<string>();
  for (const { px } of breakpoints) want.add(px <= 480 ? 'phone' : px <= 1024 ? 'tablet' : px < 1440 ? 'laptop' : 'desktop');
  if (breakpoints.some((breakpoint) => breakpoint.directions.includes('min'))) want.add('phone');
  if (breakpoints.some((breakpoint) => breakpoint.directions.includes('max'))) want.add('laptop');
  if (want.has('laptop')) want.delete('desktop');
  return [VIEWPORT_PHONE, VIEWPORT_TABLET, VIEWPORT_LAPTOP, VIEWPORT_DESKTOP].filter((viewport) => want.has(viewport.id)).map((viewport) => ({ ...viewport }));
};

const mergeBreakpoints = (screens: readonly (TailwindScreen & { origin: 'tailwind' | 'tailwind-default' })[], media: readonly MediaBreakpoint[]): ProjectBreakpoint[] => {
  const byPx = new Map<number, ProjectBreakpoint>();
  for (const screen of screens) {
    const existing = byPx.get(screen.px);
    if (existing) {
      if (!existing.directions.includes(screen.direction)) existing.directions.push(screen.direction);
      continue;
    }
    byPx.set(screen.px, { px: screen.px, directions: [screen.direction], origin: screen.origin, count: 1, ...(screen.name ? { name: screen.name } : {}) });
  }

  const counts = new Map<number, { count: number; directions: Set<'min' | 'max'> }>();
  for (const { px, direction } of media) {
    const entry = counts.get(px) ?? { count: 0, directions: new Set<'min' | 'max'>() };
    entry.count += 1;
    entry.directions.add(direction);
    counts.set(px, entry);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || a[0] - b[0]).slice(0, DISCOVERY_BREAKPOINTS_MAX);
  for (const [px, { count, directions }] of top) {
    const existing = byPx.get(px);
    if (existing) {
      existing.count += count;
      for (const direction of directions) if (!existing.directions.includes(direction)) existing.directions.push(direction);
    } else {
      byPx.set(px, { px, directions: [...directions], origin: 'css', count });
    }
  }
  return [...byPx.values()].sort((a, b) => a.px - b.px);
};

/**
 * `promise`'s answer, or `fallback` once `ms` have passed. The scan checks its clock between
 * awaits only, so a single `readdir` that never returns (a dead network share) would otherwise
 * hold the chip past the host's 20 s request timeout. The abandoned scan ends on its own.
 */
export const withDeadline = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

// ---- the scan ----

const screensWhy = (screens: readonly TailwindScreen[], fallback: string): string =>
  screens.length === 0 ? fallback : `Tailwind config (screens: ${screens.filter((s) => s.name).map((s) => `${s.name} ${s.px}`).join(' · ') || screens.map((s) => s.px).join(' · ')})`;

/**
 * Look through `projectDirectory` for the project's own design rules. Never throws: an
 * unusable folder answers a `no-project` / `unreadable` result the instructions can explain.
 */
export const discoverProjectRules = async (projectDirectory: string | null | undefined, options: DiscoveryOptions = {}): Promise<ProjectRules> => {
  const limits: DiscoveryLimits = { ...DEFAULT_DISCOVERY_LIMITS, ...options.limits };
  if (projectDirectory === null || projectDirectory === undefined || projectDirectory.trim() === '') return noProject('no project folder was given');
  const directory = projectDirectory;
  if (!path.isAbsolute(directory)) return noProject('the project folder path is not absolute', directory);
  if (path.parse(directory).root === directory) return noProject('the project folder is a drive or filesystem root', directory);
  if (options.designsRoot !== undefined && isInsideOrEqual(options.designsRoot, directory)) return noProject('this chat is working in the Designs folder, not in a project', directory);

  const info = await stat(directory).catch((error: unknown) => error as NodeJS.ErrnoException);
  if (info instanceof Error) {
    const reason = info.code === 'ENOENT' ? 'the folder does not exist' : `the folder cannot be read (${info.code ?? 'unknown error'})`;
    return { ...noProject(reason, directory), state: 'unreadable' };
  }
  if (!info.isDirectory()) return { ...noProject('it is not a folder', directory), state: 'unreadable' };

  const clock = options.now ?? Date.now;
  const startedAt = clock();
  const expired = (): boolean => clock() - startedAt > limits.timeMs;
  const walked = await walk(directory, limits, expired);
  let truncated = walked.truncated;
  const files = walked.files;

  const read = async (relative: string): Promise<string | null> => {
    if (expired()) {
      truncated = true;
      return null;
    }
    return readHead(path.join(directory, ...relative.split('/')), limits.fileBytes);
  };

  // 1. design documents
  const docs = files.filter((file) => designDocWhy(file) !== null).sort(bySpot);
  const docSources: ProjectSource[] = docs.map((file) => ({ path: file, kind: 'design-doc', why: designDocWhy(file) ?? 'design document' }));

  // 2. tokens and theme files
  const named = files.filter((file) => tokenFileWhy(file) !== null).sort(bySpot);
  const tailwindConfigs = named.filter((file) => TAILWIND_CONFIG.test(split(file).base));
  const namedTokens = named.filter((file) => !TAILWIND_CONFIG.test(split(file).base));

  const screens: (TailwindScreen & { origin: 'tailwind' | 'tailwind-default' })[] = [];
  let screensKeySeen = false;
  const tailwindSources: ProjectSource[] = [];
  for (const file of tailwindConfigs) {
    const text = await read(file);
    const parsed = text === null ? { found: false, screens: [] } : parseTailwindScreens(text);
    screensKeySeen ||= parsed.found;
    screens.push(...parsed.screens.map((screen) => ({ ...screen, origin: 'tailwind' as const })));
    tailwindSources.push({ path: file, kind: 'tokens', why: screensWhy(parsed.screens, 'Tailwind config') });
  }

  const media: MediaBreakpoint[] = [];
  const cssSources: ProjectSource[] = [];
  const styleFiles = files.filter(isStyleFile).sort(bySpot);
  if (styleFiles.length > limits.cssFiles) truncated = true;
  for (const file of styleFiles.slice(0, limits.cssFiles)) {
    const text = await read(file);
    if (text === null) continue;
    media.push(...parseMediaBreakpoints(text));
    const themeScreens = parseThemeBreakpoints(text);
    if (themeScreens.length > 0) {
      screensKeySeen = true;
      screens.push(...themeScreens.map((screen) => ({ ...screen, origin: 'tailwind' as const })));
    }
    const vars = rootVarCount(text);
    if (/@theme\b/.test(stripComments(text))) cssSources.push({ path: file, kind: 'tokens', why: 'Tailwind @theme block' });
    else if (vars >= DISCOVERY_ROOT_VARS_MIN) cssSources.push({ path: file, kind: 'tokens', why: `:root defines ${vars} custom properties` });
  }
  if (tailwindConfigs.length > 0 && !screensKeySeen) screens.push(...TAILWIND_DEFAULT_SCREENS.map((screen) => ({ ...screen, origin: 'tailwind-default' as const })));

  if (tailwindConfigs.length > 0 && !screensKeySeen) {
    for (const source of tailwindSources) source.why = 'Tailwind config (no custom screens: the stock breakpoints apply)';
  }

  const tokenSources: ProjectSource[] = [
    ...namedTokens.map((file): ProjectSource => ({ path: file, kind: 'tokens', why: tokenFileWhy(file) ?? 'design tokens' })),
    ...tailwindSources,
    ...cssSources,
  ];

  // 3. agent files, only with a design heading
  const agentCandidates = files.filter(isAgentFile).sort(bySpot);
  if (agentCandidates.length > limits.agentFiles) truncated = true;
  const agentSources: ProjectSource[] = [];
  for (const file of agentCandidates.slice(0, limits.agentFiles)) {
    const text = await read(file);
    if (text === null) continue;
    const headings = designHeadings(text);
    if (headings.length > 0) agentSources.push({ path: file, kind: 'agent-rules', why: `design sections: ${headings.map((heading) => `"${heading}"`).join('; ')}`, headings });
  }

  // De-duplicate (a tokens.css is also a `:root` file) keeping the first, higher-priority entry.
  const seen = new Set<string>();
  const ordered = [...docSources, ...tokenSources, ...agentSources].filter((source) => !seen.has(source.path) && seen.add(source.path));

  const breakpoints = mergeBreakpoints(screens, media);
  return {
    state: 'scanned',
    directory,
    note: null,
    sources: ordered.slice(0, limits.sources),
    sourcesOmitted: Math.max(0, ordered.length - limits.sources),
    breakpoints,
    viewports: suggestViewports(breakpoints),
    truncated,
  };
};
