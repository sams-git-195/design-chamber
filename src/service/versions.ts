// Content-addressed version snapshots (docs/SPEC.md §6.4, §4.9, §9.5).
//
//   .versions/index.json          { version:1, next, versions:[VersionEntry…] }  newest last
//   .versions/objects/<aa>/<sha>  raw file bytes, content-addressed
//
// Tracked set: every file under the design folder except `.versions/**`, `.chamber/**` and
// `.thumb.png`; `design.json` is stored with `comments` removed (comments live in state.json,
// which versions never touch). Snapshots: auto after a quiet period, on an agent turn, manual,
// and around restore (restore-point → write files → restored). Dedupe by tree hash; keep the
// newest VERSIONS_KEEP versions and GC unreferenced objects after pruning.
//
// Every mutation for one design runs on a per-slug promise chain: snapshot/restore interleave
// with each other and with the auto timer, never with themselves.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  mergeServiceFields,
  normalizeServiceState,
  serializeJson,
  stripForVersion,
  DESIGN_JSON_FILE,
} from '../shared/design-json.ts';
import {
  SHA256_PATTERN,
  SNAPSHOT_BYTES_MAX,
  SNAPSHOT_FILES_MAX,
  TURN_PROMOTE_AUTO_MS,
  TURN_SNAPSHOT_DEDUPE_MS,
  VERSION_ID_PATTERN,
  VERSION_LABEL_MAX,
  VERSIONS_KEEP,
  VERSION_QUIET_MS,
} from '../shared/limits.ts';
import type {
  JsonObject,
  VersionEntry,
  VersionFileChange,
  VersionIndex,
  VersionReason,
  VersionSummary,
} from '../shared/types.ts';
import { ApiError } from './http.ts';
import type { ChangeHub, DesignStore, Logger, ServiceContext } from './context.ts';
import { RefBlocked, type FileSource } from './bundle.ts';
import { resolveInside } from './paths.ts';

export const VERSIONS_DIR = '.versions';
const CHAMBER_DIR = '.chamber';
const STATE_FILE = path.join(CHAMBER_DIR, 'state.json');
const INDEX_FILE = path.join(VERSIONS_DIR, 'index.json');

const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** Tree hash of the empty tracked set (a design folder with no tracked files). */
export const EMPTY_TREE_HASH = sha256('');

// ---- tracked set ----

/** `.versions/**`, `.chamber/**`, `.thumb.png` (and its atomic-write temporaries) are never tracked. */
export const isTracked = (rel: string): boolean => {
  const segments = rel.split('/');
  if (segments[0] === VERSIONS_DIR || segments[0] === CHAMBER_DIR) return false;
  const base = segments[segments.length - 1] ?? '';
  return base !== '.thumb.png' && !base.startsWith('.thumb.');
};

/**
 * Every tracked file under the design folder, `/`-separated and sorted.
 * Symlinks are skipped: their target may live outside the design and a snapshot must not
 * capture (or restore) escapes.
 */
export const listTracked = async (designDir: string): Promise<string[]> => {
  const out: string[] = [];
  const walk = async (relDir: string): Promise<void> => {
    const fsDir = relDir === '' ? designDir : path.join(designDir, ...relDir.split('/'));
    const entries = await readdir(fsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
      if (!isTracked(rel)) continue;
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile()) out.push(rel);
    }
  };
  await walk('');
  return out.sort();
};

export type VersionTree = {
  /** Tracked rel path → sha256 of the bytes stored for it (design.json: comments stripped). */
  files: Record<string, string>;
  /** design.json's stored bytes when they differ from the live file (comments stripped). */
  transformed: Map<string, Buffer>;
  bytes: number;
  treeHash: string;
};

const parseJsonObject = (text: string): JsonObject | null => {
  try {
    const value: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as JsonObject) : null;
  } catch {
    return null;
  }
};

/** Hash (and prepare the stored bytes of) every tracked file. */
export const computeTree = async (designDir: string): Promise<VersionTree> => {
  const rels = await listTracked(designDir);
  const files: Record<string, string> = {};
  const transformed = new Map<string, Buffer>();
  let bytes = 0;
  const lines: string[] = [];
  for (const rel of rels) {
    const raw = await readFile(path.join(designDir, ...rel.split('/'))).catch(() => null);
    if (raw === null) continue; // vanished mid-walk: not part of the tree
    let content = raw;
    if (rel === DESIGN_JSON_FILE) {
      const parsed = parseJsonObject(raw.toString('utf8'));
      if (parsed !== null) content = Buffer.from(serializeJson(stripForVersion(parsed)), 'utf8');
      // Unparseable design.json (agent mid-write): stored verbatim, never transformed.
      transformed.set(rel, content);
    }
    const hash = sha256(content);
    files[rel] = hash;
    bytes += content.length;
    lines.push(`${rel}\u0000${hash}\n`);
  }
  return { files, transformed, bytes, treeHash: sha256(lines.join('')) };
};

// ---- index and objects ----

const objectPath = (designDir: string, hash: string): string => path.join(designDir, VERSIONS_DIR, 'objects', hash.slice(0, 2), hash);

/** A design-relative `/` path with no step that could leave the folder (lexical; writes still go through `resolveInside`). */
const isSafeRel = (rel: string): boolean =>
  rel !== '' &&
  !rel.includes('\u0000') &&
  !rel.includes('\\') &&
  !rel.startsWith('/') &&
  !/^[A-Za-z]:/.test(rel) &&
  rel.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');

/** index.json lives in the agent-writable design folder: every path must be tracked and safe, every object a sha256. */
const isFileMap = (value: unknown): value is Record<string, string> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.entries(value).every(([rel, hash]) => isSafeRel(rel) && isTracked(rel) && typeof hash === 'string' && SHA256_PATTERN.test(hash));

const isEntry = (value: unknown): value is VersionEntry => {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.id === 'string' &&
    VERSION_ID_PATTERN.test(entry.id) &&
    typeof entry.n === 'number' &&
    typeof entry.created === 'string' &&
    typeof entry.reason === 'string' &&
    (entry.sessionId === null || typeof entry.sessionId === 'string') &&
    typeof entry.treeHash === 'string' &&
    SHA256_PATTERN.test(entry.treeHash) &&
    isFileMap(entry.files) &&
    typeof entry.bytes === 'number'
  );
};

const readIndex = async (designDir: string, log: Logger): Promise<VersionIndex> => {
  const text = await readFile(path.join(designDir, INDEX_FILE), 'utf8').catch(() => null);
  if (text === null) return { version: 1, next: 1, versions: [] };
  const parsed: unknown = parseJsonObject(text);
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as JsonObject).version === 1 &&
    Array.isArray((parsed as JsonObject).versions)
  ) {
    const raw = parsed as { next?: unknown; versions: unknown[] };
    const versions = raw.versions.filter(isEntry);
    if (versions.length === raw.versions.length) {
      const next = typeof raw.next === 'number' && Number.isInteger(raw.next) ? raw.next : versions.reduce((max, entry) => Math.max(max, entry.n + 1), 1);
      return { version: 1, next, versions };
    }
  }
  // Corrupt index: treated as absent (the objects stay; GC after the next prune reclaims them).
  log.warn('versions.index-corrupt', { design: designDir });
  return { version: 1, next: 1, versions: [] };
};

const writeAtomic = async (target: string, bytes: Uint8Array | string): Promise<void> => {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
};

const writeIndex = async (designDir: string, index: VersionIndex): Promise<void> => {
  const file = path.join(designDir, INDEX_FILE);
  await mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, serializeJson(index as unknown as JsonObject));
};

const putObject = async (designDir: string, hash: string, bytes: Buffer): Promise<void> => {
  const target = objectPath(designDir, hash);
  const existing = await stat(target).catch(() => null);
  if (existing?.isFile()) return; // content-addressed and immutable
  await mkdir(path.dirname(target), { recursive: true });
  await writeAtomic(target, bytes);
};

/** Delete objects no version references any more (run after pruning, inside the slug's chain). */
const collectGarbage = async (designDir: string, index: VersionIndex, log: Logger): Promise<void> => {
  const referenced = new Set<string>();
  for (const entry of index.versions) for (const hash of Object.values(entry.files)) referenced.add(hash);
  const objectsDir = path.join(designDir, VERSIONS_DIR, 'objects');
  const buckets = await readdir(objectsDir, { withFileTypes: true }).catch(() => []);
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || !/^[0-9a-f]{2}$/.test(bucket.name)) continue;
    const bucketDir = path.join(objectsDir, bucket.name);
    const names = await readdir(bucketDir).catch(() => []);
    for (const name of names) {
      if (!SHA256_PATTERN.test(name)) continue; // never delete a file we cannot identify
      if (referenced.has(name)) continue;
      await unlink(path.join(bucketDir, name)).catch((error: unknown) => log.warn('versions.gc-failed', { object: name, error: error instanceof Error ? error.message : String(error) }));
    }
    const left = await readdir(bucketDir).catch(() => []);
    if (left.length === 0) await rm(bucketDir, { recursive: true, force: true });
  }
};

// ---- summaries ----

export const toSummary = (entry: VersionEntry): VersionSummary => {
  const { files, ...rest } = entry;
  return { ...rest, fileCount: Object.keys(files).length };
};

// ---- version file source (render reads a snapshot through it) ----

const validateRel = (rel: string): void => {
  if (!isSafeRel(rel)) throw new RefBlocked(rel);
};

export const createVersionFileSource = (designDir: string, files: Record<string, string>): FileSource => ({
  root: designDir,
  async read(rel) {
    validateRel(rel);
    const hash = files[rel];
    if (hash === undefined || !SHA256_PATTERN.test(hash)) return null;
    const bytes = await readFile(objectPath(designDir, hash)).catch(() => null);
    if (bytes === null) return null;
    return { bytes, size: bytes.length, mtimeMs: 0 };
  },
  async stat(rel) {
    validateRel(rel);
    const hash = files[rel];
    if (hash === undefined || !SHA256_PATTERN.test(hash)) return null;
    const info = await stat(objectPath(designDir, hash)).catch(() => null);
    return info === null ? null : { size: info.size, mtimeMs: info.mtimeMs };
  },
});

// ---- the service ----

export type SnapshotOptions = { sessionId?: string | null; label?: string };

export type VersionsService = {
  /** Brand so `ensureVersionsService` recognises an already-wired instance. */
  __dcVersionsService?: true;
  list(slug: string): Promise<{ versions: VersionSummary[]; currentTreeHash: string; dirty: boolean }>;
  /** `reason` is already validated ('turn' | 'manual'). `null` = nothing changed. */
  create(slug: string, reason: 'turn' | 'manual', options?: SnapshotOptions): Promise<VersionSummary | null>;
  snapshot(slug: string, reason: VersionReason, options?: SnapshotOptions): Promise<VersionEntry | null>;
  turn(sessionId: string): Promise<{ slug: string; id: string }[]>;
  diff(slug: string, vid: string, against: string): Promise<{ files: { path: string; change: VersionFileChange }[] }>;
  restore(slug: string, vid: string): Promise<{ restorePoint: VersionSummary | null; restored: VersionSummary }>;
  /** The snapshot's entry and a FileSource over its objects (the render service reads versions through it). */
  readTree(slug: string, vid: string): Promise<{ entry: VersionEntry; source: FileSource }>;
  /** True when an auto-snapshot timer is pending (tests). */
  autoPending(slug: string): boolean;
};

export type VersionsDeps = {
  store: DesignStore;
  hub: ChangeHub;
  log: Logger;
  onDispose: (fn: () => void | Promise<void>) => void;
  /** Auto-snapshot quiet period; `VERSION_QUIET_MS` outside tests. */
  quietMs?: number;
};

export const createVersionsService = (deps: VersionsDeps): VersionsService => {
  const { store, hub, log } = deps;
  const quietMs = deps.quietMs ?? VERSION_QUIET_MS;

  // Per-slug mutation chain.
  const chains = new Map<string, Promise<unknown>>();
  const chained = <T>(slug: string, fn: () => Promise<T>): Promise<T> => {
    const previous = chains.get(slug) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    chains.set(slug, run.then(
      () => undefined,
      () => undefined,
    ));
    return run;
  };

  // Tree cache: fingerprint = rel → size+mtime (stat only), so repeated lists/diffs are cheap.
  const treeCache = new Map<string, { fingerprint: string; tree: VersionTree }>();
  const treeOf = async (slug: string, designDir: string): Promise<VersionTree> => {
    const rels = await listTracked(designDir);
    const stats: string[] = [];
    for (const rel of rels) {
      const info = await stat(path.join(designDir, ...rel.split('/'))).catch(() => null);
      stats.push(`${rel}:${info?.size ?? -1}:${info?.mtimeMs ?? -1}`);
    }
    const fingerprint = stats.join('|');
    const cached = treeCache.get(slug);
    if (cached && cached.fingerprint === fingerprint) return cached.tree;
    const tree = await computeTree(designDir);
    treeCache.set(slug, { fingerprint, tree });
    return tree;
  };

  const readState = async (designDir: string): Promise<ReturnType<typeof normalizeServiceState>> => {
    const text = await readFile(path.join(designDir, STATE_FILE), 'utf8').catch(() => null);
    if (text === null) return null;
    const parsed: unknown = parseJsonObject(text);
    return parsed === null ? null : normalizeServiceState(parsed);
  };

  /**
   * `keep`: a version id pruning must skip (the target of a running restore, so its objects
   * survive GC). `required`: an over-cap tree throws instead of being skipped (a restore
   * point that cannot be stored must stop the restore).
   */
  const snapshotNow = async (
    slug: string,
    reason: VersionReason,
    options: SnapshotOptions & { keep?: string; required?: boolean },
  ): Promise<VersionEntry | null> => {
    const designDir = await store.dir(slug);
    // Two attempts: a file rewritten between hashing and storing its object would corrupt the
    // snapshot, so every object is hash-verified and the whole snapshot redone on a mismatch.
    let tree: VersionTree | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      tree = await treeOf(slug, designDir);
      const fileCount = Object.keys(tree.files).length;
      if (fileCount > SNAPSHOT_FILES_MAX || tree.bytes > SNAPSHOT_BYTES_MAX) {
        log.warn('versions.snapshot-skipped', { slug, reason, fileCount, bytes: tree.bytes });
        if (options.required === true) {
          throw new ApiError(
            'invalid',
            `This design is too large to keep a restore point (more than ${SNAPSHOT_FILES_MAX.toLocaleString('en-US')} files or ${Math.round(SNAPSHOT_BYTES_MAX / (1024 * 1024))} MB), so restoring now would lose your current files. Nothing was changed — remove files you no longer need, or copy the design folder somewhere safe, then try again.`,
          );
        }
        return null;
      }
      let torn = false;
      for (const [rel, hash] of Object.entries(tree.files)) {
        const content = tree.transformed.get(rel) ?? (await readFile(path.join(designDir, ...rel.split('/'))).catch(() => null));
        if (content === null || sha256(content) !== hash) {
          torn = true;
          break;
        }
        await putObject(designDir, hash, content);
      }
      if (!torn) break;
      treeCache.delete(slug);
      tree = null;
    }
    if (tree === null) throw new ApiError('conflict', 'The design changed while Design Chamber was saving it. Try again.');

    const index = await readIndex(designDir, log);
    const latest = index.versions[index.versions.length - 1];
    if (latest && latest.treeHash === tree.treeHash) {
      // The quiet-period auto snapshot often lands before the turn ends with the same files:
      // that version is the turn's result, so it becomes the "After agent turn" version.
      const recent = Date.now() - Date.parse(latest.created) <= TURN_PROMOTE_AUTO_MS;
      if (reason !== 'turn' || latest.reason !== 'auto' || !recent) return null; // dedupe by tree hash
      latest.reason = 'turn';
      latest.sessionId = options.sessionId ?? latest.sessionId;
      await writeIndex(designDir, index);
      hub.emit({ slug, kind: 'versions' });
      return latest;
    }

    const record = await store.get(slug).catch(() => null);
    const sessionId = options.sessionId ?? record?.design.sessionId ?? null;

    const n = Math.max(index.next, (latest?.n ?? 0) + 1);
    const entry: VersionEntry = {
      id: `v${n}`,
      n,
      created: new Date().toISOString(),
      reason,
      sessionId,
      treeHash: tree.treeHash,
      files: tree.files,
      bytes: tree.bytes,
      ...(options.label !== undefined ? { label: options.label.slice(0, VERSION_LABEL_MAX) } : {}),
    };
    index.versions.push(entry);
    index.next = n + 1;
    for (let excess = index.versions.length - VERSIONS_KEEP; excess > 0; excess -= 1) {
      const oldest = index.versions.findIndex((candidate) => candidate.id !== options.keep);
      if (oldest === -1) break;
      index.versions.splice(oldest, 1);
    }
    await writeIndex(designDir, index);
    await collectGarbage(designDir, index, log);
    treeCache.delete(slug);
    hub.emit({ slug, kind: 'versions' });
    return entry;
  };

  const findEntry = (index: VersionIndex, vid: string): VersionEntry => {
    const entry = index.versions.find((candidate) => candidate.id === vid);
    if (!entry) throw new ApiError('not-found', 'That version does not exist any more.');
    return entry;
  };

  const restoreNow = async (slug: string, vid: string): Promise<{ restorePoint: VersionSummary | null; restored: VersionSummary }> => {
    if (!VERSION_ID_PATTERN.test(vid)) throw new ApiError('bad-request', 'That is not a version id.');
    const designDir = await store.dir(slug);
    const index = await readIndex(designDir, log);
    const target = findEntry(index, vid);

    // Every object must exist before anything is written.
    for (const hash of Object.values(target.files)) {
      const info = await stat(objectPath(designDir, hash)).catch(() => null);
      if (!info?.isFile()) throw new ApiError('invalid', 'This version is damaged (a stored file is gone) and cannot be restored.');
    }

    const current = await treeOf(slug, designDir);
    const latest = index.versions[index.versions.length - 1];
    let restorePoint: VersionEntry | null = null;
    if (!latest || latest.treeHash !== current.treeHash) {
      // `keep`: with a full history the restore point would otherwise prune (and GC) the very
      // version being restored. `required`: no restore point → refuse before writing anything.
      restorePoint = await snapshotNow(slug, 'restore-point', { keep: target.id, required: true });
    }

    const state = await readState(designDir);
    for (const [rel, hash] of Object.entries(target.files)) {
      let bytes = await readFile(objectPath(designDir, hash));
      if (rel === DESIGN_JSON_FILE && state !== null) {
        const parsed = parseJsonObject(bytes.toString('utf8'));
        // Keep the CURRENT service-owned fields and comments (§6.4: restore never touches
        // comments or sessionId). `updated` is not bumped: the tree hash must stay the
        // version's, so no phantom "dirty" state after restore.
        if (parsed !== null) bytes = Buffer.from(serializeJson(mergeServiceFields(parsed, state)), 'utf8');
      }
      const destination = await resolveInside(designDir, rel.split('/'));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeAtomic(destination, bytes);
    }
    // Delete tracked files the version does not have (restore removes what was added since).
    for (const rel of Object.keys(current.files)) {
      if (target.files[rel] !== undefined) continue;
      await rm(await resolveInside(designDir, rel.split('/')), { force: true });
    }
    treeCache.delete(slug);
    hub.emit({ slug, kind: 'files' });

    // The restore itself is done; a torn 'restored' snapshot must not fail the route (the
    // auto timer records it seconds later).
    const restored =
      (await snapshotNow(slug, 'restored', {}).catch((error: unknown) => {
        log.warn('versions.restored-snapshot-failed', { slug, error: error instanceof Error ? error.message : String(error) });
        return null;
      })) ?? (await readIndex(designDir, log)).versions.at(-1);
    if (!restored) throw new ApiError('internal', 'The version was restored, but Design Chamber could not record the snapshot.');
    return { restorePoint: restorePoint ? toSummary(restorePoint) : null, restored: toSummary(restored) };
  };

  // Turn-snapshot dedupe across frames (§10.6): one run per session per TURN_SNAPSHOT_DEDUPE_MS.
  const turnCache = new Map<string, { at: number; result: { slug: string; id: string }[] }>();

  // Auto snapshots: hub content events restart a quiet-period timer per slug.
  const autoTimers = new Map<string, NodeJS.Timeout>();
  const cancelAuto = (slug: string): void => {
    const timer = autoTimers.get(slug);
    if (timer) clearTimeout(timer);
    autoTimers.delete(slug);
  };
  const scheduleAuto = (slug: string): void => {
    cancelAuto(slug);
    autoTimers.set(
      slug,
      setTimeout(() => {
        autoTimers.delete(slug);
        void service.snapshot(slug, 'auto').catch((error: unknown) => {
          // A design removed mid-quiet-period is normal; anything else is worth a log line.
          if (error instanceof ApiError && error.code === 'not-found') return;
          log.warn('versions.auto-failed', { slug, error: error instanceof Error ? error.message : String(error) });
        });
      }, quietMs),
    );
  };
  const unsubscribe = hub.subscribe((event) => {
    if (event.kind === 'root') {
      for (const slug of [...autoTimers.keys()]) cancelAuto(slug);
      treeCache.clear();
      return;
    }
    if (event.slug === null) return;
    if (event.kind === 'files' || event.kind === 'design' || event.kind === 'added') scheduleAuto(event.slug);
    else if (event.kind === 'removed') {
      cancelAuto(event.slug);
      treeCache.delete(event.slug);
    }
  });
  deps.onDispose(() => {
    unsubscribe();
    for (const slug of [...autoTimers.keys()]) cancelAuto(slug);
  });

  const service: VersionsService = {
    __dcVersionsService: true,

    async list(slug) {
      const designDir = await store.dir(slug);
      const index = await readIndex(designDir, log);
      const tree = await treeOf(slug, designDir);
      const latest = index.versions[index.versions.length - 1];
      const dirty = latest ? latest.treeHash !== tree.treeHash : tree.treeHash !== EMPTY_TREE_HASH;
      return {
        versions: [...index.versions].reverse().map(toSummary),
        currentTreeHash: tree.treeHash,
        dirty,
      };
    },

    create: (slug, reason, options) => chained(slug, async () => toSummaryOrNull(await snapshotNow(slug, reason, options ?? {}))),

    snapshot: (slug, reason, options) => chained(slug, () => snapshotNow(slug, reason, options ?? {})),

    async turn(sessionId) {
      const now = Date.now();
      const cached = turnCache.get(sessionId);
      if (cached && now - cached.at < TURN_SNAPSHOT_DEDUPE_MS) return cached.result;
      const designs = await store.list();
      const created: { slug: string; id: string }[] = [];
      for (const design of designs) {
        if (design.sessionId !== sessionId) continue;
        const entry = await service.snapshot(design.slug, 'turn', { sessionId }).catch((error: unknown) => {
          log.warn('versions.turn-failed', { slug: design.slug, error: error instanceof Error ? error.message : String(error) });
          return null;
        });
        if (entry) created.push({ slug: design.slug, id: entry.id });
      }
      if (turnCache.size > 1000) turnCache.clear(); // bounded; sessions are few
      turnCache.set(sessionId, { at: now, result: created });
      return created;
    },

    async diff(slug, vid, against) {
      if (!VERSION_ID_PATTERN.test(vid)) throw new ApiError('bad-request', 'That is not a version id.');
      const designDir = await store.dir(slug);
      const index = await readIndex(designDir, log);
      const a = findEntry(index, vid).files;
      let b: Record<string, string>;
      if (against === 'current') b = (await treeOf(slug, designDir)).files;
      else {
        if (!VERSION_ID_PATTERN.test(against)) throw new ApiError('bad-request', 'That is not a version id.');
        b = findEntry(index, against).files;
      }
      const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
      const files: { path: string; change: VersionFileChange }[] = [];
      for (const p of paths) {
        const left = a[p];
        const right = b[p];
        if (left === undefined && right !== undefined) files.push({ path: p, change: 'added' });
        else if (left !== undefined && right === undefined) files.push({ path: p, change: 'removed' });
        else if (left !== right) files.push({ path: p, change: 'modified' });
      }
      return { files };
    },

    restore: (slug, vid) => chained(slug, () => restoreNow(slug, vid)),

    async readTree(slug, vid) {
      if (!VERSION_ID_PATTERN.test(vid)) throw new ApiError('bad-request', 'That is not a version id.');
      const designDir = await store.dir(slug);
      const index = await readIndex(designDir, log);
      const entry = findEntry(index, vid);
      return { entry, source: createVersionFileSource(designDir, entry.files) };
    },

    autoPending: (slug) => autoTimers.has(slug),
  };
  return service;
};

const toSummaryOrNull = (entry: VersionEntry | null): VersionSummary | null => (entry === null ? null : toSummary(entry));

// ---- wiring (routes and main.ts share one instance per context) ----

const instances = new WeakMap<ServiceContext, VersionsService>();

export const ensureVersionsService = (ctx: ServiceContext): VersionsService => {
  const existing = instances.get(ctx);
  if (existing) return existing;
  const created = createVersionsService({ store: ctx.store, hub: ctx.hub, log: ctx.log, onDispose: ctx.onDispose });
  instances.set(ctx, created);
  return created;
};
