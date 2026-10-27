// "Open as artifact" (docs/SPEC.md §10.7): pull the HTML page out of an assistant message.
// `text` is the host's Markdown rendering of the message (F17), so code blocks are fenced.

import { TITLE_MAX } from '../limits.ts';
import { clip, oneLine } from './context.ts';

type Fence = { indent: number; char: string; length: number; info: string };
type Block = { info: string; content: string };

const parseOpen = (line: string): Fence | null => {
  const match = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match) return null;
  const [, indent = '', marker = '', rest = ''] = match;
  // CommonMark: a backtick fence's info string cannot contain backticks (that is inline code).
  if (marker.startsWith('`') && rest.includes('`')) return null;
  return { indent: indent.length, char: marker.charAt(0), length: marker.length, info: (rest.trim().split(/\s+/)[0] ?? '').toLowerCase() };
};

const closes = (line: string, fence: Fence): boolean => {
  const trimmed = line.trim();
  return trimmed.length >= fence.length && [...trimmed].every((char) => char === fence.char);
};

/** Every fenced code block, in order. An unterminated block runs to the end of the text. */
const fencedBlocks = (text: string): Block[] => {
  const blocks: Block[] = [];
  let open: Fence | null = null;
  let lines: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (open === null) {
      open = parseOpen(line);
      lines = [];
    } else if (closes(line, open)) {
      blocks.push({ info: open.info, content: lines.join('\n') });
      open = null;
    } else {
      // Strip the opener's indentation (a fence inside a list item) but nothing else.
      lines.push(line.replace(new RegExp(`^[ \\t]{0,${open.indent}}`), ''));
    }
  }
  if (open !== null) blocks.push({ info: open.info, content: lines.join('\n') });
  return blocks;
};

const looksLikeHtmlDocument = (content: string): boolean => /^\s*<!doctype\s+html/i.test(content) || /<(html|body)[\s>]/i.test(content);

/**
 * The HTML page in a message: fenced blocks labelled `html` / `htm`, else any fenced block that
 * starts with `<!doctype html` or contains `<html` / `<body`. The longest wins; none → `null`.
 */
export const extractHtml = (text: string): string | null => {
  let best: string | null = null;
  for (const block of fencedBlocks(text)) {
    const content = block.content.replace(/^\s*\n/, '').trimEnd();
    if (content.trim() === '') continue;
    if (block.info !== 'html' && block.info !== 'htm' && !looksLikeHtmlDocument(content)) continue;
    if (best === null || content.length > best.length) best = content;
  }
  return best;
};

const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

const decodeEntities = (text: string): string =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code.startsWith('#')) {
      const point = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
      return Number.isInteger(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });

const stripTags = (html: string): string => decodeEntities(html.replace(/<[^>]*>/g, ' '));

const fitTitle = (raw: string): string | null => {
  const flat = oneLine(raw);
  return flat === '' ? null : clip(flat, TITLE_MAX);
};

/** First Markdown heading of the message, outside code fences. */
const firstMarkdownHeading = (text: string): string | null => {
  let open: Fence | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (open !== null) {
      if (closes(line, open)) open = null;
      continue;
    }
    open = parseOpen(line);
    if (open !== null) continue;
    const heading = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading?.[1]) return heading[1];
  }
  return null;
};

/**
 * Title of an artifact made from a message: the page's `<title>`, else the message's first
 * Markdown heading, else the page's first `<h1>`, else `fallback` (the session title).
 */
export const deriveArtifactTitle = (messageText: string, html: string, fallback: string): string => {
  const candidates = [
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1],
    firstMarkdownHeading(messageText),
    /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1],
  ];
  for (const candidate of candidates) {
    const title = candidate === undefined || candidate === null ? null : fitTitle(stripTags(candidate));
    if (title !== null) return title;
  }
  return fitTitle(fallback) ?? 'HTML artifact';
};
