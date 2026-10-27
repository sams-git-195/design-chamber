// The designs-root watcher (docs/SPEC.md §9.4, §4.8) — a generalisation of design-canvas
// `service/screens-watch.ts`: an `fs.watch(root, { recursive: true })` fast path PLUS a 3 s
// stat-poll backstop, because OneDrive/network roots drop watch events (SPEC §16). On Linux
// the fast path is folder-watch.ts (one plain watch per folder) instead of Node's recursive
// mode. Events debounce 250 ms per slug, then land on the change hub as `added` / `removed` /
// `design` (design.json) / `files` (anything else, with relative paths).
//
// Ignored: every dot-path — root-level `.trash`/`.exports`, per-design `.chamber/`,
// `.versions/`, `.thumb.png` and the store's dot-prefixed tmp files — so the service's own
// writes never echo back as agent changes (together with the byte-equal merge skip in
// store.ts, that closes the watch loop).
//
// A root change (settings) restarts the watcher on the new root and emits one `root` event;
// files are never moved (§9.2). A broken fs.watch degrades to poll-only and is retried; one
// that cannot work on this root — recursive watching unsupported, or Linux's inotify watch
// limit reached (ENOSPC: every folder is a separate inotify watch there) — is logged once and not
// retried until the root changes: the poll backstop alone keeps the list live. It never kills
// the service and never reaches the user.

import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { WATCH_DEBOUNCE_MS, WATCH_POLL_MS } from '../shared/limits.ts';
import type { ChangeHub, Logger, SettingsStore } from './context.ts';
import { linuxRecursiveWatch } from './folder-watch.ts';
import { isSlug } from './paths.ts';
import { isDirectory } from './root.ts';

/** Top-level files whose mtime/size the poll backstop fingerprints (SPEC §9.4). */
const TRACKED_TOP_FILES = ['design.json', 'index.html', 'DESIGN.md', 'tokens.css'] as const;

type Fingerprint = Map<string, string>;

const fingerprintEntry = (info: { mtimeMs: number; size: number } | null): string | null =>
  info === null ? null : `${info.mtimeMs}:${info.size}`;

/**
 * Cheap per-design stat set: tracked top files, every screens/*.html, the assets/ mtime and
 * the names of the other non-dot top-level entries (so a new or removed top-level file is
 * noticed). The design folder's own mtime is not used: the service's dot writes in it
 * (`.thumb.png` publish, design.json tmp files) would read as content changes.
 */
const takeFingerprint = async (dir: string): Promise<Fingerprint> => {
  const fingerprint: Fingerprint = new Map();
  for (const name of TRACKED_TOP_FILES) {
    const info = await stat(path.join(dir, name)).catch(() => null);
    if (info?.isFile()) fingerprint.set(name, fingerprintEntry(info) ?? '');
  }
  const screensDir = path.join(dir, 'screens');
  for (const entry of await readdir(screensDir, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const info = await stat(path.join(screensDir, entry.name)).catch(() => null);
    if (info !== null) fingerprint.set(`screens/${entry.name}`, fingerprintEntry(info) ?? '');
  }
  const assets = await stat(path.join(dir, 'assets')).catch(() => null);
  if (assets?.isDirectory()) fingerprint.set('assets/', `${assets.mtimeMs}:dir`);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.') || entry.name === 'screens' || entry.name === 'assets' || fingerprint.has(entry.name)) continue;
    fingerprint.set(entry.name, 'present');
  }
  return fingerprint;
};

const diffFingerprints = (previous: Fingerprint, next: Fingerprint): string[] => {
  const changed: string[] = [];
  for (const [key, value] of next) if (previous.get(key) !== value) changed.push(key);
  for (const key of previous.keys()) if (!next.has(key)) changed.push(key);
  return changed.sort();
};

export type WatcherOptions = {
  settings: SettingsStore;
  hub: ChangeHub;
  log: Logger;
  /** Default `WATCH_DEBOUNCE_MS` (250). */
  debounceMs?: number;
  /** Default `WATCH_POLL_MS` (3000). Tests inject a small value. */
  pollMs?: number;
  /** Test seam; defaults to `fs.watch` (Linux: `linuxRecursiveWatch`). */
  watchImpl?: typeof fsWatch;
};

export type Watcher = {
  stop(): void;
  /** Settles once the startup baseline is seeded; a folder created before then is part of it, not `added`. */
  ready: Promise<void>;
};

/** Pending debounced batch per slug (`ROOT_KEY` = a whole-root rescan). */
type PendingEntry = { files: Set<string>; timer: ReturnType<typeof setTimeout> };

const ROOT_KEY = '\0root';

/** fs.watch failures that a retry cannot fix while the root stays the same. */
const PERMANENT_WATCH_FAILURES = new Set(['ENOSPC', 'ENOSYS', 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM']);

export const isPermanentWatchFailure = (error: unknown): boolean =>
  PERMANENT_WATCH_FAILURES.has(String((error as NodeJS.ErrnoException | null)?.code ?? ''));

export const startWatcher = (options: WatcherOptions): Watcher => {
  const { settings, hub, log } = options;
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const pollMs = options.pollMs ?? WATCH_POLL_MS;
  // Linux: one plain watch per folder (folder-watch.ts) — Node's recursive watch there misses
  // writes to files that were replaced by rename.
  const watchImpl = options.watchImpl ?? (process.platform === 'linux' ? linuxRecursiveWatch : fsWatch);

  let stopped = false;
  let currentRoot = settings.root();
  let watcher: FSWatcher | null = null;
  let watchErrorLogged = false;
  /** Set by a permanent failure: poll-only until the root changes. */
  let pollOnly = false;
  let knownSlugs = new Set<string>();
  const fingerprints = new Map<string, Fingerprint>();
  const pending = new Map<string, PendingEntry>();
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const schedule = (key: string, files: string[]): void => {
    if (stopped) return;
    const existing = pending.get(key);
    if (existing !== undefined) {
      for (const file of files) existing.files.add(file);
      return;
    }
    const entry: PendingEntry = {
      files: new Set(files),
      timer: setTimeout(() => {
        pending.delete(key);
        const batch = new Set(entry.files);
        const run = key === ROOT_KEY ? scanRoot() : flushSlug(key, batch);
        run.catch((error) => log.warn('watch.flush-failed', { key, error: error instanceof Error ? error.message : String(error) }));
      }, debounceMs),
    };
    // Never hold the process open for a pending tick.
    entry.timer.unref?.();
    pending.set(key, entry);
  };

  /** Fill knownSlugs/fingerprints WITHOUT emitting — used at startup and after a root switch. */
  const seedScan = async (): Promise<void> => {
    const root = currentRoot;
    knownSlugs = await readSlugs(root);
    for (const slug of knownSlugs) fingerprints.set(slug, await takeFingerprint(path.join(root, slug)));
  };

  const readSlugs = async (root: string): Promise<Set<string>> => {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => null);
    if (entries === null) return new Set();
    return new Set(entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && isSlug(entry.name)).map((entry) => entry.name));
  };

  /** Root-level diff: slugs that appeared or vanished since the last scan. */
  const scanRoot = async (): Promise<void> => {
    if (stopped) return;
    const root = currentRoot;
    const current = await readSlugs(root);
    for (const slug of knownSlugs) {
      if (current.has(slug)) continue;
      fingerprints.delete(slug);
      hub.emit({ slug, kind: 'removed' });
    }
    for (const slug of current) {
      if (knownSlugs.has(slug)) continue;
      fingerprints.set(slug, await takeFingerprint(path.join(root, slug)));
      hub.emit({ slug, kind: 'added' });
    }
    knownSlugs = current;
  };

  const flushSlug = async (slug: string, files: Set<string>): Promise<void> => {
    if (stopped) return;
    const dir = path.join(currentRoot, slug); // slug passed isSlug at schedule time or came from readSlugs
    if (!isSlug(slug) || !(await isDirectory(dir))) {
      fingerprints.delete(slug);
      if (knownSlugs.delete(slug)) hub.emit({ slug, kind: 'removed' });
      return;
    }
    if (!knownSlugs.has(slug)) {
      knownSlugs.add(slug);
      fingerprints.set(slug, await takeFingerprint(dir));
      hub.emit({ slug, kind: 'added' });
      return;
    }
    fingerprints.set(slug, await takeFingerprint(dir));
    const hasDesignJson = files.delete('design.json');
    const rest = [...files].sort();
    if (hasDesignJson) hub.emit({ slug, kind: 'design' });
    if (rest.length > 0) hub.emit({ slug, kind: 'files', files: rest });
  };

  const onWatchEvent = (filename: string | Buffer | null): void => {
    if (stopped) return;
    if (filename === null) {
      // Some platforms never name the file: rescan the root instead.
      schedule(ROOT_KEY, []);
      return;
    }
    const relative = String(filename).replace(/\\/g, '/');
    const segments = relative.split('/').filter((segment) => segment.length > 0);
    const first = segments[0];
    if (first === undefined || !isSlug(first) || first.startsWith('.')) return; // root-level files, .trash/.exports, non-designs
    const rest = segments.slice(1);
    // .chamber/, .versions/, .thumb.png and the store's .tmp files are service-owned: ignored.
    if (rest.some((segment) => segment.startsWith('.'))) return;
    schedule(first, rest.length > 0 ? [rest.join('/')] : []);
  };

  /** Log a watch failure once per root; a permanent one switches this root to poll-only. */
  const noteWatchFailure = (event: 'watch.degraded' | 'watch.unavailable', error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    if (isPermanentWatchFailure(error)) {
      if (!pollOnly) log.info('watch.poll-only', { root: currentRoot, code: (error as NodeJS.ErrnoException).code, error: message });
      pollOnly = true;
      watchErrorLogged = true;
      return;
    }
    if (!watchErrorLogged) {
      watchErrorLogged = true;
      log.warn(event, { root: currentRoot, error: message });
    }
  };

  const startFsWatch = (): void => {
    if (stopped || watcher !== null || pollOnly) return;
    try {
      watcher = watchImpl(currentRoot, { recursive: true, persistent: false }, (_event, filename) => onWatchEvent(filename));
      watcher.on('error', (error) => {
        // A broken fs.watch (EMFILE, network root) degrades to poll-only; pollTick retries
        // unless the failure is permanent (inotify limit).
        noteWatchFailure('watch.degraded', error);
        closeWatcher();
      });
    } catch (error) {
      // Root missing (retried by pollTick once it exists) or recursive watch unsupported.
      watcher = null;
      noteWatchFailure('watch.unavailable', error);
    }
  };

  const pollTick = async (): Promise<void> => {
    if (stopped) return;
    if (watcher === null && !pollOnly && (await isDirectory(currentRoot))) startFsWatch();
    await scanRoot();
    for (const slug of [...knownSlugs]) {
      const dir = path.join(currentRoot, slug);
      const next = await takeFingerprint(dir);
      const previous = fingerprints.get(slug);
      fingerprints.set(slug, next);
      if (previous === undefined) continue; // baseline seeded this tick
      const changed = diffFingerprints(previous, next);
      if (changed.length > 0) schedule(slug, changed);
    }
  };

  const clearPending = (): void => {
    for (const entry of pending.values()) clearTimeout(entry.timer);
    pending.clear();
  };

  const closeWatcher = (): void => {
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = null;
  };

  const unsubscribeRoot = settings.onRootChange((newRoot) => {
    // Never move files (§9.2): just re-point the watcher and tell the clients to refetch all.
    closeWatcher();
    clearPending();
    currentRoot = newRoot;
    pollOnly = false;
    watchErrorLogged = false;
    knownSlugs = new Set();
    fingerprints.clear();
    hub.emit({ slug: null, kind: 'root' });
    startFsWatch();
    seedScan().catch((error) => log.warn('watch.seed-failed', { error: error instanceof Error ? error.message : String(error) }));
  });

  startFsWatch();
  const ready = seedScan().catch((error) => log.warn('watch.seed-failed', { error: error instanceof Error ? error.message : String(error) }));
  pollTimer = setInterval(() => {
    pollTick().catch((error) => log.warn('watch.poll-failed', { error: error instanceof Error ? error.message : String(error) }));
  }, pollMs);
  pollTimer.unref?.();

  return {
    ready,
    stop() {
      if (stopped) return;
      stopped = true;
      unsubscribeRoot();
      closeWatcher();
      clearPending();
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    },
  };
};
