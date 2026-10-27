// A recursive watch built from one plain (non-recursive) `fs.watch` per folder — the watcher
// the designs root uses on Linux (docs/testing/PLATFORMS.md §7).
//
// Why: Node's own Linux `recursive: true` watches each FILE it found. A file replaced by
// rename — the atomic write the store, versions restore and many agents use — leaves that watch
// on the old, deleted file, so later in-place writes to design.json raise no event at all
// (observed on Node 22 and 24). A plain folder watch is an inotify watch on the directory: it
// reports every create, write and rename of its entries by name, whatever their inode.
//
// Shape: the same call signature and `FSWatcher` surface watch.ts uses (`close`, `on('error')`),
// filenames `/`-joined relative to the root. Dot folders (`.chamber/`, `.versions/`, `.trash/`)
// and, at the top level, folders that are not design names are not descended into — watch.ts
// ignores events there anyway — which also keeps the inotify watch count small. A folder that
// appears is watched and its existing entries are reported, so files written before its watch
// existed are not missed. A sub-folder watch that cannot be created (ENOSPC: inotify limit)
// is reported as an `error` on the whole watcher, so watch.ts falls back to polling.

import { EventEmitter } from 'node:events';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

import { isSlug } from './paths.ts';

type Listener = (event: string, filename: string | null) => void;

/** Whether a folder below the root is worth a watch (`rel` is `/`-separated, never empty). */
const shouldDescend = (rel: string): boolean => {
  const parts = rel.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (name.startsWith('.')) return false;
  return parts.length > 1 || isSlug(name);
};

export type FolderWatchOptions = { persistent?: boolean };

/**
 * Watch `root` and every non-dot folder below it. Throws synchronously when the root itself
 * cannot be watched (missing, ENOSPC), exactly like `fs.watch`.
 */
export const watchFolders = (root: string, options: FolderWatchOptions, listener: Listener, watchImpl: typeof fsWatch = fsWatch): FSWatcher => {
  const emitter = new EventEmitter();
  const watchers = new Map<string, FSWatcher>();
  let closed = false;

  const fail = (error: unknown): void => {
    if (closed) return;
    emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
  };

  const unwatchTree = (rel: string): void => {
    for (const [key, watcher] of [...watchers]) {
      if (key === rel || key.startsWith(`${rel}/`)) {
        watcher.close();
        watchers.delete(key);
      }
    }
  };

  /** Report a folder's entries and watch its sub-folders (a folder that just appeared, or the start). */
  const adopt = async (rel: string, report: boolean): Promise<void> => {
    const entries = await readdir(rel === '' ? root : path.join(root, ...rel.split('/')), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (closed) return;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (report) listener('rename', childRel);
      if (entry.isDirectory() && shouldDescend(childRel)) {
        watchDir(childRel);
        await adopt(childRel, report);
      }
    }
  };

  const onEntry = (rel: string, event: string, name: string | Buffer | null): void => {
    if (closed) return;
    if (name === null) {
      listener(event, rel === '' ? null : rel);
      return;
    }
    const childRel = rel === '' ? String(name) : `${rel}/${String(name)}`;
    listener(event, childRel);
    if (event !== 'rename' || !shouldDescend(childRel)) return;
    // Appeared or vanished: a new folder gets a watch (and its contents reported), a gone one loses it.
    stat(path.join(root, ...childRel.split('/')))
      .then((info) => {
        if (closed) return;
        if (!info.isDirectory()) return;
        if (!watchers.has(childRel)) {
          watchDir(childRel);
          return adopt(childRel, true);
        }
        return undefined;
      })
      .catch(() => unwatchTree(childRel))
      .catch(fail);
  };

  /** Throws only for the root; a sub-folder failure becomes an `error` event (or is ignored when it vanished). */
  const watchDir = (rel: string): void => {
    if (closed || watchers.has(rel)) return;
    const abs = rel === '' ? root : path.join(root, ...rel.split('/'));
    let watcher: FSWatcher;
    try {
      watcher = watchImpl(abs, { persistent: options.persistent ?? true }, (event, name) => onEntry(rel, event, name));
    } catch (error) {
      if (rel === '') throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(error);
      return;
    }
    watcher.on('error', (error) => {
      if (rel === '') {
        fail(error);
        return;
      }
      // A sub-folder that was removed ends its own watch; anything else is the whole watch failing.
      unwatchTree(rel);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'EPERM') fail(error);
    });
    watchers.set(rel, watcher);
  };

  watchDir('');
  adopt('', false).catch(fail);

  const handle = Object.assign(emitter, {
    close(): void {
      if (closed) return;
      closed = true;
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
      emitter.emit('close');
    },
    ref() {
      for (const watcher of watchers.values()) watcher.ref();
      return handle;
    },
    unref() {
      for (const watcher of watchers.values()) watcher.unref();
      return handle;
    },
  });
  // Safe: watch.ts uses only close() and on('error'); ref/unref are forwarded above.
  return handle as unknown as FSWatcher;
};

/** `fs.watch`-compatible recursive watch for Linux (the `recursive` option is implied). */
export const linuxRecursiveWatch = ((root: string, options: FolderWatchOptions, listener: Listener) =>
  watchFolders(root, options, listener)) as unknown as typeof fsWatch; // Safe: watch.ts calls it as (root, { recursive, persistent }, listener).
