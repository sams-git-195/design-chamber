// `<design>/.chamber/RULES.md` (docs/SPEC.md §11.2): the full instructions the chip makes
// mandatory reading. Assembly order: header → precedence (layers 1–5, the preset inlined) →
// viewports → design.json contract → rules/DESIGN-RULES.md verbatim → rules/QUESTIONS.md
// verbatim → rendering constraints. Deterministic for equal inputs (no clock), so the service
// can skip a rewrite when nothing changed.

import { BRIEF_MAX, SCREEN_DESCRIPTION_MAX, SCREENS_MAX, TITLE_MAX, VIEWPORT_HEIGHT_MAX, VIEWPORT_HEIGHT_MIN, VIEWPORT_WIDTH_MAX, VIEWPORT_WIDTH_MIN, VIEWPORTS_MAX } from '../limits.ts';
import { VIEWPORT_LAPTOP, VIEWPORT_PHONE } from '../design-json.ts';
import type { DesignKind, Viewport } from '../types.ts';
import { clip, designFilePath, formatViewport, oneLine, VIEWPORT_DESKTOP, VIEWPORT_TABLET, type AgentContext, type ProjectBreakpoint, type ProjectRules } from './context.ts';

/** The two bundled rules files, exactly as read from `rules/`. */
export type RulesDocFiles = { designRules: string; questions: string };

const kindWord = (kind: DesignKind): string => (kind === 'canvas' ? 'canvas' : 'artifact');

/** A verbatim file between markers, so the agent sees where our text ends and the file begins. */
const verbatim = (name: string, text: string): string[] => [`<!-- BEGIN ${name} (verbatim) -->`, text.endsWith('\n') ? text.slice(0, -1) : text, `<!-- END ${name} -->`];

const breakpointText = (breakpoint: ProjectBreakpoint): string => {
  const direction = breakpoint.directions.length === 2 ? 'min/max-width' : `${breakpoint.directions[0] ?? 'min'}-width`;
  const origin = breakpoint.origin === 'css' ? `${breakpoint.count}× in @media` : breakpoint.origin === 'tailwind-default' ? 'Tailwind default' : 'Tailwind config';
  return `${breakpoint.px}px (${direction}${breakpoint.name ? `, ${breakpoint.name}` : ''}; ${origin})`;
};

// ---- header ----

const fileMap = (context: AgentContext): string[] => {
  const at = (relative: string): string => designFilePath(context.folder, relative);
  return [
    `  - design.json — ${at('design.json')}`,
    context.kind === 'canvas' ? `  - one file per screen — ${at('screens/<id>.html')}` : `  - the page — ${at('index.html')}`,
    `  - tokens.css — ${at('tokens.css')}`,
    `  - DESIGN.md — ${at('DESIGN.md')}`,
    `  - assets/ — ${at('assets')}`,
    '  - Never touch: .versions/ (snapshots), .chamber/ (this file; the extension rewrites it), .thumb.png (thumbnail cache).',
  ];
};

const headerSection = (context: AgentContext): string[] => {
  const brief = clip(context.brief.trim(), BRIEF_MAX);
  const project = context.project;
  return [
    `# Design Chamber — instructions for "${clip(oneLine(context.title), TITLE_MAX)}"`,
    '',
    'This file is part of your instructions for this design. Read all of it before you design, and follow it on every later message about this design — not only the first.',
    '',
    `- Design: "${clip(oneLine(context.title), TITLE_MAX)}" (${kindWord(context.kind)})`,
    `- Folder — write ONLY inside it: ${context.folder}`,
    '- Files:',
    ...fileMap(context),
    ...(brief === '' ? ['- Brief: none — ask the user what to design.'] : ["- Brief (the user's words):", ...brief.split(/\r?\n/).map((line) => `  > ${line}`)]),
    project.directory === null
      ? '- Project folder: none open in this chat.'
      : `- Project folder (read it, never write design files into it): ${project.directory}`,
    '- Your file tools may ask permission to write in the Designs folder, because it is outside the project. That is expected; the user can allow it.',
    '',
    '## Do this, in this order',
    '',
    '1. Read this whole file. Read it again at the start of every new request about this design: it may have been refreshed.',
    '2. Look for the active project\'s design rules FIRST (Precedence, layer 2). Tell the user what you found in 2–4 lines, citing files — or say "no project context".',
    '3. Settle the viewports (Viewports).',
    '4. If anything material is unclear, ask before you build: one message, then wait (Ask when unsure). Skip the questions only if the user said "go" or the request is a small edit.',
    '5. Build only inside the folder above. Write DESIGN.md and tokens.css before the second screen. Update design.json in the same turn as the files it describes.',
    '6. Finish with the self-check at the end of Design rules. Your reply states what you built, which sources you followed, your assumptions, and at most one open question.',
  ];
};

// ---- precedence ----

const projectLayer = (project: ProjectRules): string[] => {
  const intro = [
    '### Layer 2 — the active project\'s design rules (look for these FIRST)',
    '',
  ];
  const discover = 'Also run the discovery in "Discover the project\'s design rules first" (Design rules, §2): this list can miss non-standard places. Copy the values you use into tokens.css with a comment naming the source file.';
  switch (project.state) {
    case 'no-project':
      return [
        ...intro,
        `No project folder is open in this chat (${project.note ?? 'none given'}). Ask the user whether an existing codebase or brand should be followed before you invent a look; if they say there is none, this layer is empty.`,
      ];
    case 'unreadable':
      return [
        ...intro,
        `The project folder ${project.directory ?? ''} could not be read (${project.note ?? 'unknown reason'}). Look at the project yourself. If you cannot find its design rules, ask the user; do not guess.`,
      ];
    case 'scanned': {
      const stopped = project.truncated ? ' The scan stopped early on a size or time limit, so the list may be incomplete.' : '';
      if (project.sources.length === 0) {
        return [
          ...intro,
          `Design Chamber scanned ${project.directory ?? 'the project'} and found no design documents, token/theme files, or design sections in AGENTS.md / CLAUDE.md.${stopped}`,
          '',
          `${discover} If you still find nothing, say "no project context" and follow Ask when unsure.`,
        ];
      }
      return [
        ...intro,
        `Design Chamber found these in ${project.directory ?? 'the project'} (paths relative to it; read them yourself — you are working in that project):${stopped}`,
        '',
        ...project.sources.map((source) => `- \`${source.path}\` — ${source.why}`),
        ...(project.sourcesOmitted > 0 ? [`- … and ${project.sourcesOmitted} more not listed.`] : []),
        '',
        discover,
      ];
    }
  }
};

const presetLayer = (context: AgentContext): string[] => {
  const { preset } = context;
  if (preset === null) {
    return [
      '### Layer 3 — style preset: none chosen',
      '',
      'The user did not pick a preset. If layers 1–2 do not settle the look, propose 2–3 distinct named directions yourself in your questions (Ask when unsure, §5) instead of defaulting to one.',
    ];
  }
  return [
    `### Layer 3 — style preset: ${preset.name} (\`${preset.id}\`)`,
    '',
    'The user picked this preset when creating the design. Follow it unless layer 1 or 2 says otherwise. Its CSS block seeds this design\'s tokens.css and DESIGN.md. The preset, verbatim:',
    '',
    ...verbatim(`rules/presets/${preset.id}.md`, preset.text),
  ];
};

const designSystemLayer = (context: AgentContext): string[] => {
  const { confirmed, hasDesignMd, hasTokensCss } = context.designSystem;
  const status = confirmed
    ? 'confirmed (design.json `designSystem.confirmed` is true): follow DESIGN.md and tokens.css exactly; change them only if the user asks.'
    : hasDesignMd || hasTokensCss
      ? `not confirmed yet (${[hasDesignMd ? 'DESIGN.md exists' : 'no DESIGN.md', hasTokensCss ? 'tokens.css exists' : 'no tokens.css'].join(', ')}). Treat what is there as your own proposal: show the user the palette, type and spacing, and set \`designSystem.confirmed\` to true in design.json once they accept it. A file marked \`Status: placeholder\` holds scaffold defaults, not decisions.`
      : 'not written yet. Write DESIGN.md and tokens.css once, before the second screen, from layers 1–3; set `designSystem.confirmed` to true in design.json when the user accepts them.';
  return ['### Layer 4 — this design\'s own DESIGN.md + tokens.css, once confirmed', '', `Status: ${status}`];
};

const precedenceSection = (context: AgentContext): string[] => [
  '## Precedence',
  '',
  'Highest first. A higher layer always wins. Never silently override one; if a lower layer conflicts with a higher one, say so in one line. Inside the winning layer, do not invent colours, spacing or type values it already defines.',
  '',
  '### Layer 1 — the user\'s words in chat',
  '',
  'Always first. Never ask the user to repeat something they already said in this chat.',
  '',
  ...projectLayer(context.project),
  '',
  ...presetLayer(context),
  '',
  ...designSystemLayer(context),
  '',
  '### Layer 5 — the built-in rules',
  '',
  'The "Design rules" and "Ask when unsure" sections below: anti-slop, best practices, file rules and the self-check. They apply when nothing above settles a question.',
];

// ---- viewports ----

const viewportsSection = (context: AgentContext): string[] => {
  const { project } = context;
  const found =
    project.breakpoints.length > 0
      ? [
          `Design Chamber found these breakpoints in the project: ${project.breakpoints.map(breakpointText).join(' · ')}.`,
          project.viewports.length > 0 ? `They suggest: ${project.viewports.map(formatViewport).join(', ')}. Treat that as a hint, not a decision.` : '',
        ].filter((line) => line !== '')
      : ['Design Chamber found no breakpoints in the project (or no project is open).'];
  return [
    '## Viewports',
    '',
    'Settle the viewports before you design: every screen is rendered at every viewport you list in design.json.',
    '',
    `1. Derive them from the project first. ${found.join(' ')}`,
    '2. If the project or brief makes it clear (a desktop-only admin console, a mobile app), use that and state it as an assumption; no question needed.',
    `3. Otherwise ask which viewports to show, recommending the defaults **${formatViewport(VIEWPORT_LAPTOP)} + ${formatViewport(VIEWPORT_PHONE)}**. Add ${formatViewport(VIEWPORT_TABLET)} when the layout changes there, ${formatViewport(VIEWPORT_DESKTOP)} for wide dashboards, 1080×1080 for social posts, 794×1123 for A4 print. Never assume desktop-only for a product people use on phones.`,
    `4. Record the agreed viewports in design.json \`viewports\` (1–${VIEWPORTS_MAX} items; width ${VIEWPORT_WIDTH_MIN}–${VIEWPORT_WIDTH_MAX}, height ${VIEWPORT_HEIGHT_MIN}–${VIEWPORT_HEIGHT_MAX}).`,
    '',
    `design.json lists now: ${context.viewports.map(formatViewport).join(', ')}${context.pending ? ' (the extension\'s defaults until you change them)' : ''}.`,
  ];
};

// ---- design.json contract ----

const viewportJson = (viewport: Readonly<Viewport>): string =>
  `{ "id": "${viewport.id}", "label": "${viewport.label}", "width": ${viewport.width}, "height": ${viewport.height} }`;

const contractExample = (context: AgentContext): string =>
  [
    '{',
    '  "version": 1,',
    `  "kind": "${context.kind}",`,
    '  "title": "Checkout redesign",',
    '  "created": "2026-10-26T18:00:00.000Z",',
    '  "updated": "2026-10-26T18:20:00.000Z",',
    '  "brief": "…",',
    '  "sessionId": null,',
    '  "projectDirectory": null,',
    '  "preset": null,',
    ...(context.kind === 'artifact' ? ['  "entry": "index.html",'] : []),
    '  "viewports": [',
    `    ${viewportJson(VIEWPORT_LAPTOP)},`,
    `    ${viewportJson(VIEWPORT_PHONE)}`,
    '  ],',
    ...(context.kind === 'canvas'
      ? [
          '  "screens": [',
          '    { "id": "home", "title": "Home", "file": "screens/home.html", "viewports": ["laptop", "phone"], "description": "Landing page" }',
          '  ],',
        ]
      : []),
    '  "designSystem": { "confirmed": false },',
    '  "comments": []',
    '}',
  ].join('\n');

const contractSection = (context: AgentContext): string[] => [
  '## design.json contract',
  '',
  `Schema \`design-chamber/design@1\`. The extension and you both write this file, so the keys are split by owner. Example (${kindWord(context.kind)}):`,
  '',
  '```json',
  contractExample(context),
  '```',
  '',
  '| Key | Owner | Rule |',
  '|---|---|---|',
  '| `version` | extension | Always `1`. |',
  '| `kind` | extension | `"canvas"` or `"artifact"`, fixed at creation. |',
  `| \`title\` | you | 1–${TITLE_MAX} characters. The user may rename it. |`,
  '| `created` | extension | Never change. |',
  '| `updated` | you | ISO-8601 UTC time. Set it on every change you make to the design. |',
  '| `brief` | extension | The user\'s brief. Never change. |',
  '| `sessionId`, `projectDirectory`, `preset` | extension | Links to the chat, the project and the preset. Never change. |',
  '| `entry` | extension | Artifact only: always `"index.html"`. |',
  `| \`viewports\` | you | 1–${VIEWPORTS_MAX} items \`{ id, label, width, height }\`; \`id\` letters, digits, \`-\`, \`_\`. |`,
  `| \`screens\` | you | Canvas only, 0–${SCREENS_MAX}, in the order they appear on the wall: \`{ id, title, file, viewports?, description? }\`. \`id\` is lower-case letters, digits and \`-\`; \`file\` is exactly \`screens/<id>.html\`; \`viewports\` is an optional subset of the viewport ids (default: all); \`description\` ≤ ${SCREEN_DESCRIPTION_MAX} characters. |`,
  '| `designSystem` | you | `{ "confirmed": false }`; set `true` once the user confirms DESIGN.md and tokens.css. |',
  '| `comments` | extension | The user\'s pinned comments. Never edit. |',
  '',
  '- Keep every key you do not own — including keys you do not recognise — exactly as it is. The extension puts its keys back if you change them.',
  '- Write the whole file as valid JSON in one write. A half-written file shows as an error until you fix it.',
  '- Update `screens` / `viewports` / `updated` in the same turn you write the files they describe. A listed screen whose file is missing shows as "not written yet".',
];

// ---- rendering constraints ----

const renderingSection = (): string[] => [
  '## Rendering constraints',
  '',
  'Design Chamber shows your files offline, inside a sandboxed frame. So:',
  '',
  '- Everything works with no network: no CDN scripts, web fonts, remote images or analytics. Bundle fonts and images in `assets/`.',
  '- Reference local files statically with relative paths: `assets/hero.jpg` and `tokens.css` from index.html; `../assets/hero.jpg` and `../tokens.css` from `screens/*.html`. URLs built at runtime (`new Image().src = "assets/x.png"`), `fetch()` / XHR of local files and ES-module imports across files do not load.',
  '- Small inline `<script>` interactions work (clicks, tabs, toggles). There is no `top.location`, `window.open`, cookie/localStorage assumption or network call.',
  '- Link between screens with `<a href="other-screen.html">` (a sibling file in `screens/`) or `data-dc-goto="<screenId>"`. Links to `#anchors` work; an external https link asks the user before it opens.',
  '- Give meaningful elements stable hooks (`id`, `data-screen`, semantic class names): comments are pinned to elements by selector and travel with it.',
  '- One responsive file per screen: the wall renders it at every viewport in design.json.',
];

/** The full RULES.md text for one design. */
export const buildRulesDoc = (context: AgentContext, files: RulesDocFiles): string =>
  [
    ...headerSection(context),
    '',
    ...precedenceSection(context),
    '',
    ...viewportsSection(context),
    '',
    ...contractSection(context),
    '',
    '## Design rules',
    '',
    'The built-in design rules, exactly as shipped (layer 5):',
    '',
    ...verbatim('rules/DESIGN-RULES.md', files.designRules),
    '',
    '## Ask when unsure',
    '',
    'The question protocol, exactly as shipped:',
    '',
    ...verbatim('rules/QUESTIONS.md', files.questions),
    '',
    ...renderingSection(),
    '',
  ].join('\n');
