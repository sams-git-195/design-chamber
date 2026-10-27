// The document bundler (docs/SPEC.md §4.1, §9.5): turns an agent-written HTML file and its
// local references into ONE self-contained HTML string, because a nested sandboxed frame
// cannot load guest blob URLs (F4) and relative URLs do not resolve inside a blob document.
//   <link rel=stylesheet>  → <style> with recursively processed CSS (@import, url())
//   <script src>           → inline script, `</script` escaped
//   images/fonts/media/srcset/poster/SVG href/style url() → data: URLs
//   <iframe src>           → recursively bundled data:text/html document
// Every reference is classified: local (inlined), missing, blocked (escapes the design
// folder, `<object data>`, file:/drive/UNC paths) or external (remote — left untouched, the
// host CSP blocks it and the UI reports it). Containment (paths.ts, SPEC §9.1): refs are
// classified with `isStrictlyInside`, and the live file source reads only through
// `resolveInside` (lexical rules + realpath, so symlink escapes are refused).
//
// The tokenizer is deliberately tolerant (no HTML library): unknown markup passes through
// byte-for-byte, raw-text elements (script/style/title/textarea) follow the browser's
// "first closing tag wins" rule, and malformed attributes are kept as authored.

import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import { BRIDGE_PLACEHOLDER } from '../shared/bridge-protocol.ts';
import { BUNDLE_CSS_DEPTH_MAX, BUNDLE_REFS_MAX, RENDER_DOC_MAX_BYTES } from '../shared/limits.ts';
import type { DesignWarning } from '../shared/types.ts';
import { ApiError } from './http.ts';
import { isStrictlyInside, resolveInside } from './paths.ts';

/** Thrown by a FileSource when a reference resolves outside its root. */
export class RefBlocked extends Error {
  constructor(ref: string) {
    super(`Reference escapes the design folder: ${ref}`);
    this.name = 'RefBlocked';
  }
}

/** Thrown when the bundled output exceeds RENDER_DOC_MAX_BYTES. */
export class BundleTooLarge extends Error {
  readonly bytes: number;
  constructor(bytes: number) {
    super(`The bundled document is ${bytes} bytes, over the ${RENDER_DOC_MAX_BYTES}-byte limit.`);
    this.name = 'BundleTooLarge';
    this.bytes = bytes;
  }
}

/** Thrown when the entry document itself does not exist; callers map it to 422 `no-html`. */
export class BundleMissingEntry extends Error {
  constructor(entryRel: string) {
    super(`The document ${entryRel} does not exist.`);
    this.name = 'BundleMissingEntry';
  }
}

export type SourceFile = { bytes: Buffer; size: number; mtimeMs: number };

/**
 * Where the bundler reads design-relative paths (`/` separators) from: the live design
 * folder, or a version's object store. `read` answers `null` for "does not exist" and
 * throws `RefBlocked` for a reference that escapes the root.
 */
export type FileSource = {
  /** Absolute design folder: the lexical resolution base for references (both live and version sources). */
  root: string;
  read(rel: string): Promise<SourceFile | null>;
  /** Size+mtime without reading bytes (cache validation); `null` when absent. Optional: version sources are immutable. */
  stat?(rel: string): Promise<{ size: number; mtimeMs: number } | null>;
};

/** A file the bundle read — the render cache key is built from these (§9.5). */
export type BundleInput = { rel: string; size: number; mtimeMs: number };

export type BundleMode = 'render' | 'export';

export type BundleOptions = {
  /** `render` injects the bridge placeholder at the start of `<head>`; `export` never does. */
  mode: BundleMode;
};

export type BundleResult = {
  html: string;
  /** Every file read while bundling (entry included), in first-read order. */
  inputs: BundleInput[];
  missing: string[];
  blocked: string[];
  external: string[];
  warnings: DesignWarning[];
};

// ---- MIME by extension (§9.5 table + html for iframe documents) ----

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
};

export const mimeOf = (rel: string): string => MIME[path.extname(rel).toLowerCase()] ?? 'application/octet-stream';

export const dataUrlOf = (rel: string, bytes: Buffer): string => `data:${mimeOf(rel)};base64,${bytes.toString('base64')}`;

// ---- reference classification (pure) ----

export type RefClass =
  | { kind: 'skip' } // empty, fragment, data:, blob:, javascript:, mailto:… — left untouched, not reported
  | { kind: 'external'; url: string }
  | { kind: 'blocked'; why: string }
  | { kind: 'local'; rel: string };

const SKIP_SCHEMES = new Set(['data', 'blob', 'about', 'javascript', 'mailto', 'tel', 'sms', 'callto']);
const EXTERNAL_SCHEMES = new Set(['http', 'https', 'ws', 'wss', 'ftp']);

const stripQueryFragment = (ref: string): string => {
  const at = ref.search(/[?#]/);
  return at === -1 ? ref : ref.slice(0, at);
};

const tryDecode = (ref: string): string => {
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
};

/**
 * Classify one reference found in a document or CSS file.
 * `baseRelDir` is the design-relative directory of the file containing the ref (`/` separators,
 * `''` at the design root); `designDir` is the absolute design folder.
 * Root-relative refs (`/assets/x.png`) resolve against the design root — tolerant, because a
 * blob document has no server root to resolve against.
 */
export const classifyRef = (rawRef: string, baseRelDir: string, designDir: string): RefClass => {
  const ref = rawRef.trim();
  if (ref === '' || ref.startsWith('#')) return { kind: 'skip' };
  if (ref.startsWith('\\\\')) return { kind: 'blocked', why: 'UNC paths are not rendered' };
  if (/^[A-Za-z]:[/\\]/.test(ref)) return { kind: 'blocked', why: 'absolute drive paths are not rendered' };
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(ref);
  if (scheme) {
    const name = (scheme[1] ?? '').toLowerCase();
    if (SKIP_SCHEMES.has(name)) return { kind: 'skip' };
    if (EXTERNAL_SCHEMES.has(name)) return { kind: 'external', url: ref };
    if (name === 'file') return { kind: 'blocked', why: 'file: URLs are not rendered' };
    // Unknown scheme (chrome-extension:, app schemes): left untouched, reported so the user sees it did not load.
    return { kind: 'external', url: ref };
  }
  if (ref.startsWith('//')) return { kind: 'external', url: ref };

  const cleaned = stripQueryFragment(ref).replace(/\\/g, '/');
  if (cleaned === '') return { kind: 'skip' };
  const decoded = tryDecode(cleaned);
  if (decoded.includes('\u0000')) return { kind: 'blocked', why: 'the reference contains a NUL character' };
  const absolute = decoded.startsWith('/')
    ? path.resolve(designDir, `.${decoded}`)
    : path.resolve(designDir, ...baseRelDir.split('/').filter(Boolean), decoded);
  if (!isStrictlyInside(designDir, absolute)) return { kind: 'blocked', why: 'the reference points outside the design folder' };
  return { kind: 'local', rel: path.relative(path.resolve(designDir), absolute).split(path.sep).join('/') };
};

// ---- tolerant HTML tokenizer ----

type Attr = { name: string; value: string | null; raw: string; replaced?: string };
type Tag = { name: string; lower: string; attrs: Attr[]; end: number; selfClosing: boolean };

const RAW_TEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);
const WS = new Set([' ', '\t', '\n', '\r', '\f']);

const parseTagAt = (text: string, lt: number): Tag | null => {
  const nameMatch = /^[A-Za-z][^\s/>]*/.exec(text.slice(lt + 1, lt + 128));
  if (!nameMatch) return null;
  const name = nameMatch[0];
  const attrs: Attr[] = [];
  let i = lt + 1 + name.length;
  let selfClosing = false;
  for (;;) {
    while (i < text.length && WS.has(text[i] ?? '')) i += 1;
    const c = text[i];
    if (c === undefined) {
      // Unterminated tag at EOF: the rest of the file is the tag (tolerant, like a browser).
      return { name, lower: name.toLowerCase(), attrs, end: text.length, selfClosing: false };
    }
    if (c === '>') {
      i += 1;
      break;
    }
    if (c === '/' && text[i + 1] === '>') {
      selfClosing = true;
      i += 2;
      break;
    }
    if (c === '/') {
      // Stray slash inside a tag (`<div / >`): skip it.
      i += 1;
      continue;
    }
    const attrStart = i;
    while (i < text.length && !WS.has(text[i] ?? '') && text[i] !== '=' && text[i] !== '>' && !(text[i] === '/' && text[i + 1] === '>')) i += 1;
    const attrName = text.slice(attrStart, i);
    if (attrName === '') {
      // Guarantees termination: always make progress.
      i += 1;
      continue;
    }
    let j = i;
    while (j < text.length && WS.has(text[j] ?? '')) j += 1;
    let value: string | null = null;
    if (text[j] === '=') {
      j += 1;
      while (j < text.length && WS.has(text[j] ?? '')) j += 1;
      const quote = text[j];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, j + 1);
        value = text.slice(j + 1, close === -1 ? text.length : close);
        i = close === -1 ? text.length : close + 1;
      } else {
        const valueStart = j;
        while (j < text.length && !WS.has(text[j] ?? '') && text[j] !== '>') j += 1;
        value = text.slice(valueStart, j);
        i = j;
      }
    } else {
      i = attrStart + attrName.length;
    }
    attrs.push({ name: attrName.toLowerCase(), value, raw: text.slice(attrStart, i) });
  }
  return { name, lower: name.toLowerCase(), attrs, end: i, selfClosing };
};

const escapeAttr = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

const serializeTag = (tag: Tag, drop: ReadonlySet<string> = new Set()): string => {
  let out = `<${tag.name}`;
  for (const attr of tag.attrs) {
    if (drop.has(attr.name)) continue;
    out += attr.replaced !== undefined ? ` ${attr.name}="${escapeAttr(attr.replaced)}"` : ` ${attr.raw}`;
  }
  return out + (tag.selfClosing ? ' />' : '>');
};

/** End of a raw-text element's content: the first `</name` a browser would honour. */
const findRawTextEnd = (text: string, from: number, tag: string): number => {
  const re = new RegExp(`</${tag}(?=[\\s>/]|$)`, 'gi');
  re.lastIndex = from;
  const match = re.exec(text);
  return match ? match.index : text.length;
};

/** `</script` inside inlined JS would end the element early in a browser; `<\/script` is the standard escape (case preserved). */
export const escapeScriptBody = (js: string): string => js.replace(/<\/script/gi, (match) => `<\\${match.slice(1)}`);

// ---- bundler state ----

type BundleState = {
  source: FileSource;
  designDir: string;
  inputs: Map<string, { size: number; mtimeMs: number }>;
  inlined: Set<string>;
  missing: Set<string>;
  blocked: Set<string>;
  external: Set<string>;
  warnings: DesignWarning[];
  warned: Set<string>;
  /** Documents currently being bundled (iframe recursion cycle + depth guard). */
  docStack: Set<string>;
};

const warn = (state: BundleState, code: string, message: string): void => {
  if (state.warned.has(code)) return;
  state.warned.add(code);
  state.warnings.push({ code, message });
};

type ResolveResult = { kind: 'file'; file: SourceFile } | { kind: 'missing' } | { kind: 'blocked' } | { kind: 'skip' };

/** Read one classified local ref, enforcing the 500-ref cap and recording the input for the cache key. */
const resolveLocal = async (rel: string, originalRef: string, state: BundleState): Promise<ResolveResult> => {
  if (!state.inlined.has(rel) && state.inlined.size >= BUNDLE_REFS_MAX) {
    warn(state, 'too-many-refs', `This design references more than ${BUNDLE_REFS_MAX} local files; the rest are left as they are and will not load.`);
    return { kind: 'skip' };
  }
  try {
    const file = await state.source.read(rel);
    if (file === null) {
      state.missing.add(originalRef.trim());
      return { kind: 'missing' };
    }
    state.inputs.set(rel, { size: file.size, mtimeMs: file.mtimeMs });
    state.inlined.add(rel);
    return { kind: 'file', file };
  } catch (error) {
    if (error instanceof RefBlocked) {
      state.blocked.add(originalRef.trim());
      return { kind: 'blocked' };
    }
    throw error;
  }
};

/** Classify + resolve; answers the data URL to write, or `null` to leave the reference as authored. */
const inlineRef = async (rawRef: string, baseRelDir: string, state: BundleState): Promise<string | null> => {
  const classified = classifyRef(rawRef, baseRelDir, state.designDir);
  if (classified.kind === 'skip') return null;
  if (classified.kind === 'external') {
    state.external.add(classified.url);
    return null;
  }
  if (classified.kind === 'blocked') {
    state.blocked.add(rawRef.trim());
    return null;
  }
  const resolved = await resolveLocal(classified.rel, rawRef, state);
  if (resolved.kind !== 'file') return null;
  return dataUrlOf(classified.rel, resolved.file.bytes);
};

// ---- CSS ----

const IMPORT_RE = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")]*?))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;

const dirOfRel = (rel: string): string => {
  const dir = path.posix.dirname(rel);
  return dir === '.' ? '' : dir;
};

const processCss = async (css: string, baseRelDir: string, state: BundleState, depth: number, importStack: ReadonlySet<string>): Promise<string> => {
  if (depth > BUNDLE_CSS_DEPTH_MAX) {
    warn(state, 'css-depth', `CSS @import nesting is deeper than ${BUNDLE_CSS_DEPTH_MAX} levels; deeper files are not inlined.`);
    return css;
  }

  // 1. @import → inline the imported sheet (wrapped in @media when one was given).
  const jobs: Promise<{ start: number; end: number; replacement: string }>[] = [];
  for (const match of css.matchAll(IMPORT_RE)) {
    const rawUrl = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '';
    const media = (match[6] ?? '').trim();
    const start = match.index ?? 0;
    const end = start + match[0].length;
    jobs.push(
      (async () => {
        const classified = classifyRef(rawUrl, baseRelDir, state.designDir);
        if (classified.kind === 'external') {
          state.external.add(classified.url);
          return { start, end, replacement: match[0] };
        }
        if (classified.kind === 'skip') return { start, end, replacement: match[0] };
        if (classified.kind === 'blocked') {
          state.blocked.add(rawUrl.trim());
          return { start, end, replacement: match[0] };
        }
        if (importStack.has(classified.rel)) {
          warn(state, 'css-cycle', 'A CSS @import loop was found; the repeated file is not inlined again.');
          return { start, end, replacement: `/* Design Chamber: skipped @import cycle ${classified.rel} */` };
        }
        const resolved = await resolveLocal(classified.rel, rawUrl, state);
        if (resolved.kind !== 'file') {
          return { start, end, replacement: `/* Design Chamber: missing @import ${rawUrl.trim()} */` };
        }
        const inner = await processCss(resolved.file.bytes.toString('utf8'), dirOfRel(classified.rel), state, depth + 1, new Set([...importStack, classified.rel]));
        return { start, end, replacement: media === '' ? inner : `@media ${media} {\n${inner}\n}` };
      })(),
    );
  }
  const replacements = await Promise.all(jobs);
  if (replacements.length > 0) {
    replacements.sort((a, b) => a.start - b.start);
    let out = '';
    let pos = 0;
    for (const r of replacements) {
      out += css.slice(pos, r.start) + r.replacement;
      pos = r.end;
    }
    css = out + css.slice(pos);
  }

  // 2. url() → data URLs. Manual scan: quotes and spaces inside values must not confuse it.
  const lower = css.toLowerCase();
  let out = '';
  let i = 0;
  for (;;) {
    const idx = lower.indexOf('url(', i);
    if (idx === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, idx);
    let j = idx + 4;
    while (j < css.length && WS.has(css[j] ?? '')) j += 1;
    const quote = css[j];
    let urlText: string;
    let after: number;
    if (quote === '"' || quote === "'") {
      const close = css.indexOf(quote, j + 1);
      if (close === -1) {
        out += css.slice(idx);
        break;
      }
      urlText = css.slice(j + 1, close);
      after = close + 1;
      while (after < css.length && WS.has(css[after] ?? '')) after += 1;
      if (css[after] !== ')') {
        out += css.slice(idx, idx + 4);
        i = idx + 4;
        continue;
      }
      after += 1;
    } else {
      const urlStart = j;
      while (j < css.length && css[j] !== ')' && !WS.has(css[j] ?? '')) j += 1;
      urlText = css.slice(urlStart, j);
      while (j < css.length && WS.has(css[j] ?? '')) j += 1;
      if (css[j] !== ')') {
        out += css.slice(idx, idx + 4);
        i = idx + 4;
        continue;
      }
      after = j + 1;
    }
    const dataUrl = await inlineRef(urlText, baseRelDir, state);
    // data: URLs contain no space, quote or `)`, so an unquoted url() token stays valid CSS.
    out += dataUrl === null ? css.slice(idx, after) : `url(${dataUrl})`;
    i = after;
  }
  return out;
};

// ---- HTML ----

const MODULE_IMPORT_RE = /(?:\bfrom|\bimport)\s*\(?\s*['"]\.{1,2}\//;

type UrlAttrPlan = 'data' | 'srcset' | 'css' | 'object-data' | 'iframe-src';

const urlAttrPlan = (tagLower: string, attrName: string): UrlAttrPlan | null => {
  if (attrName === 'srcset' && (tagLower === 'img' || tagLower === 'source')) return 'srcset';
  if (attrName === 'style') return 'css';
  if (attrName === 'data' && tagLower === 'object') return 'object-data';
  if (attrName === 'src') return tagLower === 'iframe' || tagLower === 'frame' ? 'iframe-src' : 'data';
  if (attrName === 'poster' && (tagLower === 'video' || tagLower === 'audio')) return 'data';
  // SVG: <image href>, <use href>, and xlink:href on any element.
  if (attrName === 'xlink:href') return 'data';
  if (attrName === 'href' && (tagLower === 'image' || tagLower === 'use')) return 'data';
  return null;
};

const rewriteSrcset = async (value: string, baseRelDir: string, state: BundleState): Promise<string> => {
  const parts = value.split(',').map(async (candidate) => {
    const trimmed = candidate.trim();
    if (trimmed === '') return candidate;
    const split = trimmed.split(/\s+/);
    const url = split[0] ?? '';
    const descriptor = split.slice(1).join(' ');
    const dataUrl = await inlineRef(url, baseRelDir, state);
    const rewritten = dataUrl ?? url;
    return descriptor === '' ? rewritten : `${rewritten} ${descriptor}`;
  });
  return (await Promise.all(parts)).join(', ');
};

/** Bundle a nested document for an `<iframe src>`; returns its data: URL, or null to leave as authored. */
const bundleSubDocument = async (rel: string, originalRef: string, state: BundleState): Promise<string | null> => {
  if (state.docStack.has(rel)) {
    warn(state, 'iframe-cycle', 'An iframe embeds a document that embeds it back; the repeated frame is not inlined.');
    state.blocked.add(originalRef.trim());
    return null;
  }
  if (state.docStack.size >= BUNDLE_CSS_DEPTH_MAX) {
    warn(state, 'iframe-depth', `Nested iframes are deeper than ${BUNDLE_CSS_DEPTH_MAX} levels; deeper frames are not inlined.`);
    return null;
  }
  const resolved = await resolveLocal(rel, originalRef, state);
  if (resolved.kind !== 'file') return null;
  state.docStack.add(rel);
  try {
    const html = await processHtml(resolved.file.bytes.toString('utf8'), dirOfRel(rel), state);
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  } finally {
    state.docStack.delete(rel);
  }
};

const handleIframeSrc = async (rawRef: string, baseRelDir: string, state: BundleState): Promise<string | null> => {
  const classified = classifyRef(rawRef, baseRelDir, state.designDir);
  if (classified.kind === 'skip') return null;
  if (classified.kind === 'external') {
    state.external.add(classified.url);
    return null;
  }
  if (classified.kind === 'blocked') {
    state.blocked.add(rawRef.trim());
    return null;
  }
  return bundleSubDocument(classified.rel, rawRef, state);
};

const LINK_URL_RELS = new Set(['icon', 'shortcut', 'apple-touch-icon', 'preload', 'modulepreload']);

const processHtml = async (text: string, baseRelDir: string, state: BundleState): Promise<string> => {
  let out = '';
  let pos = 0;
  const len = text.length;
  while (pos < len) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) {
      out += text.slice(pos);
      break;
    }
    out += text.slice(pos, lt);
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      const stop = end === -1 ? len : end + 3;
      out += text.slice(lt, stop);
      pos = stop;
      continue;
    }
    if (text.startsWith('<!', lt) || text.startsWith('<?', lt) || text.startsWith('</', lt)) {
      const gt = text.indexOf('>', lt);
      const stop = gt === -1 ? len : gt + 1;
      out += text.slice(lt, stop);
      pos = stop;
      continue;
    }
    const tag = parseTagAt(text, lt);
    if (tag === null) {
      out += '<';
      pos = lt + 1;
      continue;
    }

    // Raw-text elements: their content is text, ended by the first matching close tag.
    if (RAW_TEXT_TAGS.has(tag.lower)) {
      const contentEnd = findRawTextEnd(text, tag.end, tag.lower);
      const content = text.slice(tag.end, contentEnd);
      if (tag.lower === 'script') {
        const src = tag.attrs.find((attr) => attr.name === 'src');
        if (src?.value) {
          const classified = classifyRef(src.value, baseRelDir, state.designDir);
          let body: string | null = null;
          if (classified.kind === 'local') {
            const resolved = await resolveLocal(classified.rel, src.value, state);
            if (resolved.kind === 'file') body = escapeScriptBody(resolved.file.bytes.toString('utf8'));
          } else if (classified.kind === 'external') {
            state.external.add(classified.url);
          } else if (classified.kind === 'blocked') {
            state.blocked.add(src.value.trim());
          }
          if (body === null) {
            // External, blocked or missing: leave the tag exactly as authored (the CSP-blocked load stays visible).
            out += serializeTag(tag) + content;
          } else {
            if (MODULE_IMPORT_RE.test(body)) {
              warn(state, 'module-import', 'A script imports another file with a relative path; imports cannot load inside Design Chamber. Ask the agent to bundle the script into one file.');
            }
            out += serializeTag(tag, new Set(['src'])) + body;
          }
        } else {
          if (content !== '' && MODULE_IMPORT_RE.test(content)) {
            warn(state, 'module-import', 'A script imports another file with a relative path; imports cannot load inside Design Chamber. Ask the agent to bundle the script into one file.');
          }
          out += serializeTag(tag) + content;
        }
      } else if (tag.lower === 'style') {
        out += serializeTag(tag) + (await processCss(content, baseRelDir, state, 0, new Set()));
      } else {
        // title/textarea: text only, never rewritten.
        out += text.slice(lt, contentEnd);
      }
      pos = contentEnd;
      continue;
    }

    if (tag.lower === 'link') {
      const rel = (tag.attrs.find((attr) => attr.name === 'rel')?.value ?? '').toLowerCase();
      const relTokens = new Set(rel.split(/[\s,]+/).filter(Boolean));
      const href = tag.attrs.find((attr) => attr.name === 'href');
      if (relTokens.has('stylesheet') && href?.value) {
        const classified = classifyRef(href.value, baseRelDir, state.designDir);
        let css: string | null = null;
        if (classified.kind === 'local') {
          const resolved = await resolveLocal(classified.rel, href.value, state);
          if (resolved.kind === 'file') css = await processCss(resolved.file.bytes.toString('utf8'), dirOfRel(classified.rel), state, 0, new Set([classified.rel]));
        } else if (classified.kind === 'external') {
          state.external.add(classified.url);
        } else if (classified.kind === 'blocked') {
          state.blocked.add(href.value.trim());
        }
        if (css === null) {
          out += serializeTag(tag);
        } else {
          const media = tag.attrs.find((attr) => attr.name === 'media');
          out += `${media?.value ? `<style media="${escapeAttr(media.value)}">` : '<style>'}${css}</style>`;
        }
        pos = tag.end;
        continue;
      }
      if (href?.value && [...relTokens].some((token) => LINK_URL_RELS.has(token))) {
        const dataUrl = await inlineRef(href.value, baseRelDir, state);
        if (dataUrl !== null) href.replaced = dataUrl;
      }
      out += serializeTag(tag);
      pos = tag.end;
      continue;
    }

    // Generic attribute rewriting (img/video/source/input/embed/object/svg…).
    const jobs: Promise<void>[] = [];
    for (const attr of tag.attrs) {
      if (attr.value === null) continue;
      const plan = urlAttrPlan(tag.lower, attr.name);
      if (plan === null) continue;
      if (plan === 'object-data') {
        // CSP object-src 'none': plugin content never renders. Report, leave as authored.
        state.blocked.add(attr.value.trim());
        continue;
      }
      const value = attr.value;
      jobs.push(
        (async () => {
          let replaced: string | null = null;
          if (plan === 'srcset') replaced = await rewriteSrcset(value, baseRelDir, state);
          else if (plan === 'css') replaced = await processCss(value, baseRelDir, state, 0, new Set());
          else if (plan === 'iframe-src') replaced = await handleIframeSrc(value, baseRelDir, state);
          else replaced = await inlineRef(value, baseRelDir, state);
          if (replaced !== null) attr.replaced = replaced;
        })(),
      );
    }
    await Promise.all(jobs);
    out += serializeTag(tag);
    pos = tag.end;
  }
  return out;
};

/** Inject the bridge placeholder at the start of `<head>` (creating one when the document has none). */
export const injectBridgePlaceholder = (html: string): string => {
  const head = /<head(?:\s[^>]*)?>/i.exec(html);
  if (head) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + BRIDGE_PLACEHOLDER + html.slice(at);
  }
  const htmlTag = /<html(?:\s[^>]*)?>/i.exec(html);
  const anchor = htmlTag ?? /<!doctype[^>]*>/i.exec(html);
  if (anchor) {
    const at = anchor.index + anchor[0].length;
    return `${html.slice(0, at)}<head>${BRIDGE_PLACEHOLDER}</head>${html.slice(at)}`;
  }
  // A fragment without html/head: the comment is inert and the guest still finds it.
  return BRIDGE_PLACEHOLDER + html;
};

/**
 * Bundle one design document into a single self-contained HTML string.
 * `entryRel` is design-relative with `/` separators (`index.html`, `screens/home.html`).
 * Throws `BundleMissingEntry` when the entry does not exist and `BundleTooLarge` over the cap.
 */
export const bundleDocument = async (source: FileSource, entryRel: string, options: BundleOptions): Promise<BundleResult> => {
  const entry = await source.read(entryRel).catch((error: unknown) => {
    if (error instanceof RefBlocked) throw new BundleMissingEntry(entryRel);
    throw error;
  });
  if (entry === null) throw new BundleMissingEntry(entryRel);
  const designDir = path.resolve(source.root);
  const state: BundleState = {
    source,
    designDir,
    inputs: new Map([[entryRel, { size: entry.size, mtimeMs: entry.mtimeMs }]]),
    inlined: new Set(),
    missing: new Set(),
    blocked: new Set(),
    external: new Set(),
    warnings: [],
    warned: new Set(),
    docStack: new Set([entryRel]),
  };
  let html = await processHtml(entry.bytes.toString('utf8'), dirOfRel(entryRel), state);
  if (options.mode === 'render') html = injectBridgePlaceholder(html);

  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > RENDER_DOC_MAX_BYTES) throw new BundleTooLarge(bytes);

  return {
    html,
    inputs: [...state.inputs.entries()].map(([rel, meta]) => ({ rel, ...meta })),
    missing: [...state.missing],
    blocked: [...state.blocked],
    external: [...state.external],
    warnings: state.warnings,
  };
};

// ---- live-folder file source ----

const readFileSafe = (file: string): Promise<Buffer | null> => readFile(file).catch(() => null);
const statSafe = (file: string): Promise<Stats | null> => stat(file).catch(() => null);

/** Design-folder source: every path goes through `resolveInside` (lexical rules + realpath, so symlink/junction escapes are refused). */
export const createLiveFileSource = (designDir: string): FileSource => {
  /** The contained real path of `rel`; `RefBlocked` on any escape, `null` when the filesystem cannot answer (→ missing). */
  const resolveContained = async (rel: string): Promise<string | null> => {
    try {
      return await resolveInside(designDir, rel.split('/').filter((part) => part !== '' && part !== '.'));
    } catch (error) {
      if (error instanceof ApiError && error.code === 'bad-path') throw new RefBlocked(rel);
      return null; // ENOTDIR, EACCES… while resolving: treated as a missing file
    }
  };

  return {
    root: designDir,
    async read(rel) {
      const real = await resolveContained(rel);
      if (real === null) return null;
      const [bytes, info] = await Promise.all([readFileSafe(real), statSafe(real)]);
      if (bytes === null || info === null || !info.isFile()) return null; // absent, vanished mid-bundle, or a folder → missing
      return { bytes, size: info.size, mtimeMs: info.mtimeMs };
    },
    async stat(rel) {
      const real = await resolveContained(rel);
      if (real === null) return null;
      const info = await statSafe(real);
      if (info === null || !info.isFile()) return null;
      return { size: info.size, mtimeMs: info.mtimeMs };
    },
  };
};
