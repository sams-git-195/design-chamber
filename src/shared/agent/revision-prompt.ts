// The "send comments" message (docs/SPEC.md §11.4) and the short "continue in chat" message.
// One revision request carries every comment with the element it is pinned to. The host caps
// prompt text at 16 000 chars (F13), so an oversized request shrinks in a fixed order:
// drop each anchor's `html`, then shorten each anchor's `text`, then send only the first K
// comments (the rest stay open for another send).

import { REVISION_TEXT_MAX } from '../limits.ts';
import type { AnchorState, Comment, DesignKind, Screen, Viewport } from '../types.ts';
import { clip, codeSpan, formatViewport, rulesPathOf } from './context.ts';

export type RevisionInput = {
  title: string;
  kind: DesignKind;
  /** Absolute design folder. */
  folder: string;
  screens: readonly Screen[];
  viewports: readonly Viewport[];
  /** In the order they are numbered (oldest first). */
  comments: readonly Comment[];
  /** Per comment id (absent = found exactly); only `moved` / `detached` change the text. */
  anchorStates?: Readonly<Record<string, AnchorState>>;
  /** Default `REVISION_TEXT_MAX`. */
  maxChars?: number;
};

export type RevisionPrompt = {
  text: string;
  /** Comments in `text`, in order. */
  commentIds: string[];
  /** Comments left out by the length cap. */
  omitted: string[];
  /** 0 full · 1 no `html` · 2 `text` shortened too · 3 also fewer comments. */
  level: 0 | 1 | 2 | 3;
};

/** Anchor `text` is cut to this many characters at ladder level 2. */
const SHORT_TEXT_MAX = 40;

type Detail = 'full' | 'no-html' | 'short';

const location = (input: RevisionInput, comment: Comment): string => {
  const viewport = input.viewports.find((candidate) => candidate.id === comment.viewport);
  const at = viewport ? formatViewport(viewport) : comment.viewport;
  if (comment.screen === null) return `Artifact index.html @ ${at}`;
  const screen = input.screens.find((candidate) => candidate.id === comment.screen);
  return `Screen "${screen?.title ?? comment.screen}" (${screen?.file ?? `screens/${comment.screen}.html`}) @ ${at}`;
};

const flag = (state: AnchorState | undefined): string => {
  if (state === 'moved') return ' (moved — matched by text)';
  if (state === 'detached') return ' (not found in current file)';
  return '';
};

const renderComment = (input: RevisionInput, comment: Comment, number: number, detail: Detail, bodyMax = Number.POSITIVE_INFINITY): string => {
  const { anchor } = comment;
  const text = detail === 'short' ? clip(anchor.text, SHORT_TEXT_MAX) : anchor.text;
  const parts = [
    ...(text === '' ? [] : [`text: "${text.replace(/\s+/g, ' ')}"`]),
    ...(detail === 'full' && anchor.html !== '' ? [`html: ${codeSpan(anchor.html)}`] : []),
  ];
  const body = clip(comment.body.trim(), bodyMax)
    .split(/\r?\n/)
    .map((line, index) => (index === 0 ? line : `   ${line}`))
    .join('\n');
  return [
    `${number}. ${location(input, comment)}`,
    `   element: ${codeSpan(anchor.selector)}${flag(input.anchorStates?.[comment.id])}`,
    ...(parts.length > 0 ? [`   ${parts.join('  ')}`] : []),
    `   → ${body}`,
  ].join('\n');
};

const header = (input: RevisionInput, count: number, total: number): string[] => [
  `[Design Chamber] Revise "${clip(input.title.replace(/\s+/g, ' ').trim(), 120)}" — ${count} comment${count === 1 ? '' : 's'}${count < total ? ` of ${total} (the rest will follow in a later message)` : ''}. Folder: ${input.folder}. Rules: ${rulesPathOf(input.folder)}`,
  'Change only what the comments ask; keep everything else. Update design.json "updated". Reply per comment number.',
];

const render = (input: RevisionInput, comments: readonly Comment[], total: number, detail: Detail): string =>
  [...header(input, comments.length, total), ...comments.map((comment, index) => renderComment(input, comment, index + 1, detail))].join('\n');

/** The revision request for `input.comments`, shrunk to fit `maxChars` by the ladder above. */
export const buildRevisionPrompt = (input: RevisionInput): RevisionPrompt => {
  const max = input.maxChars ?? REVISION_TEXT_MAX;
  const all = input.comments;
  const done = (text: string, included: readonly Comment[], level: RevisionPrompt['level']): RevisionPrompt => ({
    text,
    commentIds: included.map((comment) => comment.id),
    omitted: all.slice(included.length).map((comment) => comment.id),
    level,
  });

  const levels: [Detail, RevisionPrompt['level']][] = [['full', 0], ['no-html', 1], ['short', 2]];
  for (const [detail, level] of levels) {
    const text = render(input, all, all.length, detail);
    if (text.length <= max) return done(text, all, level);
  }

  // Level 3: as many leading comments as fit, in their shortest form.
  const included: Comment[] = [];
  for (const comment of all) {
    const next = [...included, comment];
    if (render(input, next, all.length, 'short').length > max) break;
    included.push(comment);
  }
  if (included.length === 0 && all[0] !== undefined) {
    // One comment alone is over the cap: keep it, with its body cut to fit.
    const first = all[0];
    const overhead = [...header(input, 1, all.length), renderComment(input, first, 1, 'short', 0)].join('\n').length;
    const bodyMax = Math.max(1, max - overhead - 1);
    const text = [...header(input, 1, all.length), renderComment(input, first, 1, 'short', bodyMax)].join('\n');
    return done(text.length <= max ? text : text.slice(0, max), [first], 3);
  }
  return done(render(input, included, all.length, 'short'), included, 3);
};

export type ContinueInput = { title: string; kind: DesignKind; folder: string; openComments: number };

/** First message of a new chat that resumes an existing design (the old chat is gone). */
export const buildContinuePrompt = (input: ContinueInput): string =>
  [
    `[Design Chamber] Resuming the ${input.kind} "${clip(input.title.replace(/\s+/g, ' ').trim(), 120)}". Folder: ${input.folder}. Rules: ${rulesPathOf(input.folder)}`,
    'Read the rules file first, then look at the files in the folder. Tell me in 2–3 lines where the design stands, then ask what I want to change next. Do not change any file yet.',
    ...(input.openComments > 0 ? [`${input.openComments} pinned comment${input.openComments === 1 ? ' is' : 's are'} waiting; I will send them when I am ready.`] : []),
  ].join('\n');
