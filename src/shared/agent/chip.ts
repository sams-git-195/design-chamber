// The chip core text (docs/SPEC.md §11.3): the compact message that rides on `/design`,
// `/artifact` and "Continue in chat". The host caps chip text at 16 000 chars (F15) and the full
// rules are far longer, so the core makes `<design>/.chamber/RULES.md` mandatory reading and
// carries only what the agent needs before it opens that file.

import { BRIEF_MAX, CHIP_PROJECT_PATHS_MAX, HOST_ATTACH_TITLE_MAX, HOST_ATTACH_URL_MAX, TITLE_MAX } from '../limits.ts';
import { VIEWPORT_LAPTOP, VIEWPORT_PHONE } from '../design-json.ts';
import { CHIP_PROVIDER_ID, type DesignChip, type DesignKind } from '../types.ts';
import { clip, formatViewport, oneLine, rulesPathOf, type AgentContext, type ProjectRules } from './context.ts';

/** `new`: the design was just created. `continue`: it exists; the chat is (re)starting work on it. */
export type ChipMode = 'new' | 'continue';

const PATH_SHOWN_MAX = 100;
const DIRECTORY_SHOWN_MAX = 260;

const kindWord = (kind: DesignKind): string => (kind === 'canvas' ? 'canvas' : 'artifact');

/** A short design title from the user's brief: its first sentence, ≤ 60 chars on a word boundary. */
export const titleFromBrief = (brief: string, kind: DesignKind): string => {
  const firstLine = brief.split(/\r?\n/).map(oneLine).find((line) => line !== '') ?? '';
  const sentence = /^(.{8,}?)(?:[.!?:;](?:\s|$)|$)/.exec(firstLine)?.[1] ?? firstLine;
  let title = sentence.replace(/[.!?:;\s]+$/, '');
  if (title.length > 60) {
    const cut = title.slice(0, 60);
    const lastSpace = cut.lastIndexOf(' ');
    title = (lastSpace >= 30 ? cut.slice(0, lastSpace) : cut).trimEnd();
  }
  return title === '' ? `New ${kindWord(kind)}` : `${title.charAt(0).toUpperCase()}${title.slice(1)}`;
};

const breakpointList = (project: ProjectRules): string => [...new Set(project.breakpoints.map((breakpoint) => breakpoint.px))].slice(0, 8).join(', ');

const projectStep = (project: ProjectRules): string => {
  const directory = project.directory === null ? '' : clip(project.directory, DIRECTORY_SHOWN_MAX);
  switch (project.state) {
    case 'no-project':
      return `No project folder is open in this chat (${project.note ?? 'none given'}). Ask the user whether an existing codebase or brand should be followed before you invent a look.`;
    case 'unreadable':
      return `The project folder ${directory} could not be read (${project.note ?? 'unknown reason'}). Look at the project yourself; if you cannot find its design rules, ask the user.`;
    case 'scanned': {
      const shown = project.sources.slice(0, CHIP_PROJECT_PATHS_MAX);
      const more = project.sources.length + project.sourcesOmitted - shown.length;
      if (shown.length === 0) {
        return `Design Chamber found no design docs, token/theme files or design sections in ${directory}. Check the project yourself (RULES.md, "Discover the project's design rules first"); if you still find none, say "no project context" and ask your questions.`;
      }
      const paths = shown.map((source) => clip(source.path, PATH_SHOWN_MAX)).join(', ');
      return `Design Chamber found these in ${directory}: ${paths}${more > 0 ? ` (+${more} more, listed in RULES.md)` : ''}. Read them yourself and follow them; also search for anything it missed (RULES.md, "Discover the project's design rules first").`;
    }
  }
};

const DEFAULT_VIEWPORTS = `${formatViewport(VIEWPORT_LAPTOP)} + ${formatViewport(VIEWPORT_PHONE)}`;

const viewportStep = (context: AgentContext, mode: ChipMode): string => {
  if (mode === 'continue') {
    return `Viewports: this design shows ${context.viewports.map(formatViewport).join(', ')}. Change them only if the user asks, and keep design.json "viewports" in step with what you build.`;
  }
  const suggested = context.project.viewports;
  if (suggested.length > 0) {
    return `Viewports — settle them before designing. The project's breakpoints (${breakpointList(context.project)}) suggest ${suggested.map(formatViewport).join(', ')}; use them unless the brief says otherwise, and ask if unsure. With no clear answer, use ${DEFAULT_VIEWPORTS}.`;
  }
  return `Viewports — settle them before designing. The project gave no breakpoints, so ask which to show unless the brief makes it obvious, and recommend ${DEFAULT_VIEWPORTS}.`;
};

const stateLine = (context: AgentContext): string => {
  if (context.pending) return 'State: nothing written yet.';
  if (context.kind === 'artifact') return 'State: index.html is written.';
  const ids = clip(context.screenIds.join(', '), 400);
  return `State: ${context.screenIds.length} screen${context.screenIds.length === 1 ? '' : 's'}${ids === '' ? '' : ` (${ids})`}.`;
};

const filesStep = (kind: DesignKind): string =>
  kind === 'canvas'
    ? 'Files you write: design.json · screens/<id>.html (one self-contained, responsive file per screen) · tokens.css · DESIGN.md · assets/** (relative paths, no CDNs). Never touch .versions/, .chamber/ or .thumb.png.'
    : 'Files you write: design.json · index.html (one self-contained page) · tokens.css · DESIGN.md · assets/** (relative paths, no CDNs). Never touch .versions/, .chamber/ or .thumb.png.';

/** The chip core text. Always ≤ `CHIP_TEXT_HARD_MAX` (the brief is clipped to `BRIEF_MAX`, every path is clipped). */
export const buildChipText = (context: AgentContext, mode: ChipMode): string => {
  const title = clip(oneLine(context.title), TITLE_MAX);
  const brief = clip(context.brief.trim(), BRIEF_MAX);
  const lines = [
    `[Design Chamber] ${mode === 'new' ? 'New' : 'Continue'} ${kindWord(context.kind)}: "${title}"`,
    brief === '' ? 'Brief: none — ask the user what to design.' : `Brief (the user's words${mode === 'new' ? '' : ', original'}):\n${brief}`,
    ...(mode === 'continue' ? [stateLine(context)] : []),
    `Write ONLY inside this folder: ${context.folder}`,
    '',
    `1. FIRST read, in full: ${rulesPathOf(context.folder)}`,
    '   It is part of this message — the complete design rules, the ask-when-unsure protocol and the design.json contract. Design nothing before you have read it.',
    `2. THEN look for the active project's own design rules before designing: ${projectStep(context.project)}`,
    `3. Precedence, highest first — never silently override a higher layer: the user's words in this chat · the project's design rules (step 2) · style preset (${context.preset ? context.preset.name : 'none chosen'}) · this design's DESIGN.md + tokens.css once confirmed · the built-in rules in RULES.md.`,
    `4. ${viewportStep(context, mode)}`,
    '5. Unsure about anything material? Ask first: ONE message with 3–6 short numbered questions, each with a bold recommended default, then wait for the answer. Do not ask what the project files already answer; skip the questions if the user said "go" or this is a small edit.',
    `6. ${filesStep(context.kind)}`,
    `7. design.json: you own ${context.kind === 'canvas' ? 'title, updated, viewports, screens and designSystem' : 'title, updated, viewports and designSystem'} — keep every other key exactly as it is, and set "updated" (ISO time) whenever you change the design. Full contract in RULES.md.`,
    'Your file tools may ask permission to write in the Designs folder because it is outside the project; that is expected.',
  ];
  return lines.join('\n');
};

/** The attach chip for a design: `id = design:<slug>`, `url` = the folder's file URL (`''` when over the host cap). */
export const buildChip = (context: AgentContext, input: { slug: string; mode: ChipMode; folderUrl: string }): DesignChip => ({
  providerId: CHIP_PROVIDER_ID,
  id: `design:${input.slug}`,
  title: clip(oneLine(context.title), HOST_ATTACH_TITLE_MAX),
  url: input.folderUrl.length <= HOST_ATTACH_URL_MAX ? input.folderUrl : '',
  text: buildChipText(context, input.mode),
  data: { slug: input.slug, kind: context.kind },
});
