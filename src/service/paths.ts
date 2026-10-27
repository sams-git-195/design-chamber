// The one path-containment module (docs/SPEC.md §9.1) plus the slug rules (§6.1) and the
// atomic-write helper every service write goes through.
//
// Every path that originates from a request, from design.json, or from a watched filename is
// resolved with `resolveInside` before any filesystem access. It rejects absolute segments,
// NUL, `..` segments, drive letters and UNC prefixes lexically, then defends against
// symlink/junction escapes with `fs.realpath` of the deepest existing ancestor, comparing
// against the realpath'd root (case-insensitively on win32 and darwin — see `foldsCase`).
//
// `PathModule`, `realpath` and the platform are injectable so the win32 and darwin rules are
// testable on any platform via `path.win32` / `path.posix` (SPEC §15.1).

import { readFileSync, renameSync } from 'node:fs';
import { realpath as fsRealpath, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PlatformPath } from 'node:path';

import { SLUG_BASE_MAX, SLUG_FALLBACK, SLUG_PATTERN } from '../shared/limits.ts';
import { ApiError } from './http.ts';

/** The subset of a node:path flavour this module uses (`path`, `path.win32` or `path.posix`). */
export type PathModule = Pick<PlatformPath, 'resolve' | 'relative' | 'isAbsolute' | 'join' | 'dirname' | 'basename' | 'parse' | 'sep'>;

export type ContainmentDeps = {
  /** Path flavour; defaults to the platform's `node:path`. */
  path?: PathModule;
  /** Resolves symlinks/junctions; defaults to `fs.promises.realpath`. */
  realpath?: (target: string) => Promise<string>;
  /** Case-insensitive containment comparison; defaults to `foldsCase(path, platform)`. */
  caseInsensitive?: boolean;
  /** Defaults to `process.platform`; only consulted for the case rule. */
  platform?: NodeJS.Platform;
};

const badPath = (message: string): ApiError => new ApiError('bad-path', message);

/**
 * Whether path comparisons ignore case: the win32 flavour always (NTFS), and darwin, whose
 * default APFS/HFS+ volumes are case-insensitive — `/Users/me/documents` IS `~/Documents`
 * there, so an exact comparison would let a re-cased path slip past "inside home" and
 * "same root" checks. Linux filesystems are case-sensitive: exact. (A darwin user on an
 * opt-in case-sensitive volume gets the folded rule: a symlink to a sibling whose name
 * differs from the root only by case would count as inside — accepted, see
 * docs/testing/PLATFORMS.md.)
 */
export const foldsCase = (p: PathModule = path, platform: NodeJS.Platform = process.platform): boolean => p.sep === '\\' || platform === 'darwin';

/** True when a `path.relative` result means "outside": a leading `..` or an absolute path. */
const isEscaping = (relative: string, p: PathModule): boolean =>
  relative === '..' || relative.startsWith(`..${p.sep}`) || p.isAbsolute(relative);

/** `path.relative` of two resolved paths under the platform's case rule. */
const relativeFolded = (from: string, to: string, p: PathModule, platform: NodeJS.Platform): string => {
  const left = p.resolve(from);
  const right = p.resolve(to);
  return foldsCase(p, platform) ? p.relative(left.toLowerCase(), right.toLowerCase()) : p.relative(left, right);
};

/** Cross-platform absolute-dir equality for one path flavour (case rule per `foldsCase`). */
export const samePath = (a: string, b: string, p: PathModule = path, platform: NodeJS.Platform = process.platform): boolean => {
  const left = p.resolve(a);
  const right = p.resolve(b);
  return foldsCase(p, platform) ? left.toLowerCase() === right.toLowerCase() : left === right;
};

/** True when `dir` is `root` itself or a descendant of it (lexical, flavour-aware). */
export const isInsideOrEqual = (root: string, dir: string, p: PathModule = path, platform: NodeJS.Platform = process.platform): boolean => {
  const relative = relativeFolded(root, dir, p, platform);
  return relative === '' || !isEscaping(relative, p);
};

/**
 * True when `target` is strictly below `base` (lexical, flavour-aware; case rule per
 * `foldsCase`). The disk-free core of `resolveInside`, for callers that only classify a path
 * (the bundler's reference classifier); anything that reads or writes uses `resolveInside`.
 */
export const isStrictlyInside = (base: string, target: string, p: PathModule = path, platform: NodeJS.Platform = process.platform): boolean => {
  const relative = relativeFolded(base, target, p, platform);
  return relative !== '' && !isEscaping(relative, p);
};

const defaultRealpath = (target: string): Promise<string> => fsRealpath(target);

/**
 * `fs.realpath` of the deepest existing ancestor of `target`, rejoined with the missing tail.
 * ENOENT walks up; any other filesystem error is surfaced (loud in code).
 */
const realpathDeepestAncestor = async (target: string, p: PathModule, realpath: (t: string) => Promise<string>): Promise<string> => {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return rest.length === 0 ? real : p.join(real, ...rest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = p.dirname(current);
    if (parent === current) throw badPath('The designs folder does not exist.');
    rest.unshift(p.basename(current));
    current = parent;
  }
};

/**
 * Resolve `segments` under `root`, refusing anything that could leave the root: absolute
 * segments, NUL, `..` segments (in either separator), drive letters (`C:\`, `C:foo`), UNC
 * prefixes (`\\server`, `//server`) — and, through the realpath comparison, symlinks or
 * junctions inside the root that point outside it. Answers the realpath'd absolute path.
 * The root itself must exist; the target below it may not (a file about to be created).
 */
export const resolveInside = async (root: string, segments: readonly string[], deps: ContainmentDeps = {}): Promise<string> => {
  const p = deps.path ?? path;
  const realpath = deps.realpath ?? defaultRealpath;
  const caseInsensitive = deps.caseInsensitive ?? foldsCase(p, deps.platform ?? process.platform);

  if (typeof root !== 'string' || root.trim() === '') throw badPath('The designs folder is not set.');
  if (root.includes('\0')) throw badPath('The designs folder path contains an invalid character.');

  for (const segment of segments) {
    if (typeof segment !== 'string' || segment === '') throw badPath('That path has an empty step, which is not allowed.');
    if (segment.includes('\0')) throw badPath('That path contains an invalid character.');
    if (p.isAbsolute(segment) || /^[A-Za-z]:/.test(segment) || segment.startsWith('\\\\') || segment.startsWith('//')) {
      throw badPath('Only paths inside the designs folder are allowed.');
    }
    // `..` in either separator flavour — a posix flavour must still refuse win32-style walks.
    if (segment.split(/[\\/]+/).some((part) => part === '..')) {
      throw badPath('Paths may not step up out of the designs folder.');
    }
  }

  const rootResolved = p.resolve(root);
  const target = p.resolve(rootResolved, ...segments);
  if (isEscaping(p.relative(rootResolved, target), p)) throw badPath('Only paths inside the designs folder are allowed.');

  let realRoot: string;
  try {
    realRoot = await realpath(rootResolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw badPath('The designs folder does not exist yet.');
    throw error;
  }
  const realTarget = await realpathDeepestAncestor(target, p, realpath);
  const realRelative = caseInsensitive ? p.relative(realRoot.toLowerCase(), realTarget.toLowerCase()) : p.relative(realRoot, realTarget);
  if (isEscaping(realRelative, p)) throw badPath('That path leaves the designs folder, so Design Chamber refuses it.');
  return realTarget;
};

// ---- Slugs (§6.1, §9.1) ----

export const isSlug = (value: unknown): value is string => typeof value === 'string' && SLUG_PATTERN.test(value);

/** Throws `bad-slug` unless `value` is a design folder name. */
export const assertSlug = (value: unknown): string => {
  if (!isSlug(value)) throw new ApiError('bad-slug', 'That is not a design name.');
  return value;
};

/** Device names Windows reserves in every folder (`con`, `nul`, `com1`…): a design folder must never be one. */
export const isWindowsReservedName = (name: string): boolean => /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(name);

/**
 * Title → slug base: NFKD, fold diacritics to ASCII, kebab-case, ≤ `SLUG_BASE_MAX` cut at a word
 * boundary (a hard cut only when the first word alone is that long), fallback `design`; a
 * Windows device name gets `-design`.
 */
export const slugify = (title: string): string => {
  const folded = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const kebab = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let base = kebab;
  if (kebab.length > SLUG_BASE_MAX) {
    const cut = kebab.slice(0, SLUG_BASE_MAX + 1);
    const lastDash = cut.lastIndexOf('-');
    base = (lastDash > 0 ? cut.slice(0, lastDash) : cut.slice(0, SLUG_BASE_MAX)).replace(/-+$/g, '');
  }
  if (!isSlug(base)) return SLUG_FALLBACK;
  return isWindowsReservedName(base) ? `${base}-design` : base;
};

/** First free slug: `base`, then `base-2`, `base-3`, … (SPEC §6.1). */
export const uniqueSlug = async (base: string, isTaken: (slug: string) => Promise<boolean>): Promise<string> => {
  const start = isSlug(base) && !isWindowsReservedName(base) ? base : SLUG_FALLBACK;
  if (!(await isTaken(start))) return start;
  for (let suffix = 2; suffix <= 1000; suffix += 1) {
    const candidate = `${start}-${suffix}`;
    if (!isSlug(candidate)) break; // beyond the 63-char slug pattern
    if (!(await isTaken(candidate))) return candidate;
  }
  throw new ApiError('conflict', 'Too many designs share this name — choose a different title.');
};

// ---- Atomic writes ----

/**
 * Write a file via tmp + rename in its own folder (a partial write is never visible, and the
 * tmp name is dot-prefixed so the watcher ignores it — SPEC §9.4). Creates parent folders.
 */
export const writeFileAtomic = async (file: string, data: string | Uint8Array): Promise<void> => {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
};

/**
 * Atomic write that replaces `file` only while it still holds `expected` (`null` = absent);
 * false when another writer changed it first or holds it locked, and nothing is written. The final
 * compare + rename runs synchronously, so the window another writer can slip into shrinks to
 * the rename itself (the two-writer merge of design.json, §6.3).
 */
export const replaceFileIfUnchanged = async (file: string, expected: string | null, data: string): Promise<boolean> => {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  await writeFile(tmp, data);
  try {
    let current: string | null | undefined;
    try {
      current = readFileSync(file, 'utf8');
    } catch (error) {
      // Unreadable right now (e.g. EBUSY while the other writer holds it): treated as changed.
      current = (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : undefined;
    }
    if (current !== expected) {
      await rm(tmp, { force: true });
      return false;
    }
    try {
      renameSync(tmp, file);
    } catch (error) {
      // Windows refuses to replace a file another process is reading this instant: not
      // replaced yet, the caller retries.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') throw error;
      await rm(tmp, { force: true });
      return false;
    }
    return true;
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
};
