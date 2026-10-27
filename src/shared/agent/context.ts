// What the instruction builders (chip, RULES.md, revision prompt) know about a design and its
// project (docs/SPEC.md §11). Pure types and helpers: no filesystem, no Node imports, so the
// guest bundles can import this folder too.

import type { DesignKind, Viewport } from '../types.ts';

// ---- Project-rules discovery result [§11.1] ----

export type ProjectSourceKind = 'design-doc' | 'tokens' | 'agent-rules';

export type ProjectSource = {
  /** Relative to the project folder, `/` separators. */
  path: string;
  kind: ProjectSourceKind;
  /** Short reason the file matters ("Tailwind config — breakpoints sm 640 · md 768"). */
  why: string;
  /** Agent files only: the headings that mention design (≤ 6). */
  headings?: string[];
};

/** `tailwind-default`: the config exists but sets no `screens`, so Tailwind's stock breakpoints apply. */
export type BreakpointOrigin = 'tailwind' | 'tailwind-default' | 'css';

export type ProjectBreakpoint = {
  /** CSS px (`em`/`rem` converted at 16 px). */
  px: number;
  /** `min` = mobile-first (`min-width`, Tailwind screens), `max` = desktop-first (`max-width`). */
  directions: ('min' | 'max')[];
  origin: BreakpointOrigin;
  /** `@media` occurrences found (`1` for a configured screen). */
  count: number;
  /** Tailwind screen name (`md`), when known. */
  name?: string;
};

export type ProjectRulesState =
  /** No project folder was given, or it is the filesystem root / the Designs folder itself. */
  | 'no-project'
  /** A folder was given but cannot be read. */
  | 'unreadable'
  | 'scanned';

export type ProjectRules = {
  state: ProjectRulesState;
  /** Absolute project folder as given (null for `no-project` without a folder). */
  directory: string | null;
  /** Why `no-project` / `unreadable`; null otherwise. */
  note: string | null;
  /** Priority order: design docs, tokens/theme, agent files with a design heading. ≤ `DISCOVERY_SOURCES_MAX`. */
  sources: ProjectSource[];
  /** Sources found beyond the cap. */
  sourcesOmitted: number;
  breakpoints: ProjectBreakpoint[];
  /** Suggested viewports derived from `breakpoints` (empty = none found: use the defaults). */
  viewports: Viewport[];
  /** A size or time limit stopped the scan early. */
  truncated: boolean;
};

export const noProject = (note: string, directory: string | null = null): ProjectRules => ({
  state: 'no-project',
  directory,
  note,
  sources: [],
  sourcesOmitted: 0,
  breakpoints: [],
  viewports: [],
  truncated: false,
});

// ---- Viewports beyond the two defaults (rules/QUESTIONS.md §4) ----

export const VIEWPORT_TABLET: Readonly<Viewport> = Object.freeze({ id: 'tablet', label: 'Tablet', width: 768, height: 1024 });
export const VIEWPORT_DESKTOP: Readonly<Viewport> = Object.freeze({ id: 'desktop', label: 'Desktop', width: 1440, height: 900 });

export const formatViewport = (viewport: Pick<Viewport, 'label' | 'width' | 'height'>): string =>
  `${viewport.label} ${viewport.width}×${viewport.height}`;

// ---- What a builder needs to know about one design ----

export type AgentPreset = {
  id: string;
  name: string;
  /** The preset file, verbatim (RULES.md inlines it). */
  text: string;
};

export type AgentContext = {
  title: string;
  kind: DesignKind;
  /** Absolute design folder. */
  folder: string;
  /** The user's brief; empty when none. */
  brief: string;
  project: ProjectRules;
  preset: AgentPreset | null;
  /** The viewports design.json lists now (the service seeds the defaults). */
  viewports: Viewport[];
  /** Canvas screen ids design.json lists now. */
  screenIds: string[];
  /** No entry/screen file exists yet. */
  pending: boolean;
  designSystem: { confirmed: boolean; hasDesignMd: boolean; hasTokensCss: boolean };
};

// ---- Paths shown to the agent ----

/** `folder` + parts with the separator the folder already uses (Windows `\` or POSIX `/`). */
export const joinFolder = (folder: string, ...parts: string[]): string => {
  const separator = folder.includes('\\') ? '\\' : '/';
  const base = folder.endsWith('\\') || folder.endsWith('/') ? folder.slice(0, -1) : folder;
  return [base, ...parts].join(separator);
};

/** Absolute path of a `/`-separated path inside the design folder, in the folder's own separator style. */
export const designFilePath = (folder: string, relative: string): string => joinFolder(folder, ...relative.split('/'));

/** `<folder>/.chamber/RULES.md`: the assembled instructions the chip makes mandatory reading. */
export const rulesPathOf = (folder: string): string => joinFolder(folder, '.chamber', 'RULES.md');

/** Cut to `max` characters, ending in `…` when something was dropped. */
export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/** Collapse every run of whitespace (newlines included) to one space. */
export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Markdown inline code that survives backticks inside `text`. */
export const codeSpan = (text: string): string => {
  const flat = oneLine(text);
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  return longest > 0 ? `${fence} ${flat} ${fence}` : `${fence}${flat}${fence}`;
};
