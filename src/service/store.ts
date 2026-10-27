// The designs store (docs/SPEC.md §9.3, §6.1–§6.3): everything the service knows about the
// design folders under the root — listing, reading, creating, patching, trashing, comments —
// and the two-writer merge that keeps `design.json` (agent-written) and `.chamber/state.json`
// (service-owned truth) consistent.
//
// Merge rule (§6.3): service-owned fields (version, kind, created, brief, sessionId,
// projectDirectory, preset, entry, comments) live in state.json; design.json carries a
// mirror. Service writes go state.json first, then the mirror (agent fields, unknown keys
// and key order preserved; skipped when the bytes are equal → no watch loop). When the
// watcher reports a design.json change, `reconcile` re-reads both files and re-merges the
// mirror if any service-owned field drifted — an agent overwrite that dropped the comments
// is restored. A design.json that fails to parse is NEVER written over (WP0 deviation 8);
// a missing one is created on the first service-side mutation (§6.1).
//
// All writes are tmp+rename (`writeFileAtomic`); every path from a slug goes through
// `resolveInside`; per-slug locks serialise read-modify-write cycles.

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CreateCommentBody, PatchCommentBody, PatchDesignBody } from '../shared/api.ts';
import {
  applyServiceState,
  createDesignDocument,
  DESIGN_JSON_FILE,
  ENTRY_FILE,
  mergeServiceFields,
  normalizeServiceState,
  parseDesignJsonText,
  screenFileOf,
  serializeJson,
  serviceFieldsDiffer,
  serviceStateOf,
  type ServiceWrite,
} from '../shared/design-json.ts';
import {
  BRIEF_MAX,
  COMMENTS_MAX,
  TITLE_MAX,
} from '../shared/limits.ts';
import type {
  Comment,
  DesignFiles,
  DesignJson,
  DesignKind,
  DesignSummary,
  DesignWarning,
  FileStatus,
  JsonObject,
  JsonValue,
  ServiceState,
  ThumbState,
} from '../shared/types.ts';
import type { ChangeHub, DesignRecord, DesignStore, Logger, SettingsStore, ThumbnailService } from './context.ts';
import { ApiError } from './http.ts';
import { assertSlug, isSlug, replaceFileIfUnchanged, resolveInside, slugify, uniqueSlug, writeFileAtomic } from './paths.ts';
import { folderErrorSentence, isDesignFolder, isDirectory } from './root.ts';

/** `.chamber/state.json` — the service-owned truth (§6.3). */
const stateFileOf = (dir: string): string => path.join(dir, '.chamber', 'state.json');

/** Mirror writes retried (with a growing pause) after an agent write or a Windows file lock; then left to reconcile. */
const MIRROR_ATTEMPTS = 5;
const MIRROR_RETRY_MS = 25;

const fileStatus = async (file: string): Promise<FileStatus> => {
  try {
    const info = await stat(file);
    return { exists: info.isFile(), size: info.size, mtime: info.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
};

/** A design read from disk, including the raw file the mirror merge must preserve. */
type InternalRead = {
  record: DesignRecord;
  /** Parsed design.json object, or null when missing/unparseable. */
  raw: JsonObject | null;
  /** design.json text, or null when the file is missing. */
  designText: string | null;
  /** False when state.json was missing or corrupt (state then comes from design.json). */
  stateFromDisk: boolean;
};

const timestampOf = (date: Date): string => {
  const two = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`;
};

const mintCommentId = (existing: ReadonlySet<string>): string => {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const id = `c_${randomBytes(6).toString('hex')}`;
    if (!existing.has(id)) return id;
  }
  // Unreachable in practice: 10 collisions in a 2^48 id space means a broken RNG.
  throw new ApiError('conflict', 'Could not mint a fresh comment id — please try again.');
};

export type DesignStoreOptions = {
  settings: SettingsStore;
  log: Logger;
  /** When present, the store emits change events and subscribes for the §6.3 merge. */
  hub?: ChangeHub;
  /** WP2's cheap thumb state for list summaries; falls back to `unavailable` while unbuilt. */
  thumbnails?: Pick<ThumbnailService, 'peek'>;
  /** Test seam. */
  now?: () => Date;
};

/** The store plus `reconcile`, which the watcher path calls through the hub subscription. */
export type DesignStoreWithReconcile = DesignStore & { reconcile(slug: string): Promise<void> };

export const createDesignStore = (options: DesignStoreOptions): DesignStoreWithReconcile => {
  const { settings, log, hub } = options;
  const now = options.now ?? ((): Date => new Date());
  const hooks = new Set<(record: DesignRecord) => Promise<void>>();
  /** List summaries keyed by a cheap stat fingerprint (§9.3 "cached by mtimes"). */
  const summaryCache = new Map<string, { key: string; summary: DesignSummary }>();
  /** Per-slug write serialisation: no read-modify-write without a lock. */
  const locks = new Map<string, Promise<unknown>>();
  settings.onRootChange(() => summaryCache.clear());

  const withLock = async <T>(slug: string, fn: () => Promise<T>): Promise<T> => {
    const prev = locks.get(slug) ?? Promise.resolve();
    // Assigned synchronously by the Promise constructor below, before the first await.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.catch(() => undefined).then(() => gate);
    locks.set(slug, chain);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
      if (locks.get(slug) === chain) locks.delete(slug);
    }
  };

  /** Contained, existing design folder for a slug. Throws `bad-slug` or `not-found`. */
  const designDir = async (slug: string): Promise<string> => {
    assertSlug(slug);
    const root = settings.root();
    if (!(await isDirectory(root))) throw new ApiError('not-found', 'That design does not exist.');
    const dir = await resolveInside(root, [slug]);
    // A slug-named folder that is not a design (the user's own) is never read or written into.
    if (!(await isDirectory(dir)) || !(await isDesignFolder(dir))) throw new ApiError('not-found', 'That design does not exist.');
    return dir;
  };

  const readInternal = async (slug: string): Promise<InternalRead> => {
    const dir = await designDir(slug);
    const folderTime = (await stat(dir)).mtime.toISOString();

    const stateText = await readFile(stateFileOf(dir), 'utf8').catch(() => null);
    let state: ServiceState | null = null;
    if (stateText !== null) {
      try {
        state = normalizeServiceState(JSON.parse(stateText));
      } catch {
        state = null;
      }
      if (state === null) log.warn('store.state-unparseable', { slug, message: 'state.json is damaged; service fields are rebuilt from design.json.' });
    }

    const designText = await readFile(path.join(dir, DESIGN_JSON_FILE), 'utf8').catch(() => null);
    const entryStatus = await fileStatus(path.join(dir, ENTRY_FILE));
    // §6.1: a folder without design.json but with index.html is an artifact.
    const kind: DesignKind = state?.kind ?? (entryStatus.exists ? 'artifact' : 'canvas');
    const parsed = parseDesignJsonText(designText ?? '{}', { kind, fallbackTitle: slug, fallbackTime: folderTime });
    const warnings: DesignWarning[] =
      designText === null
        ? [{ code: 'no-design-json', message: 'This design has no design.json yet — the agent may still write it.' }, ...parsed.warnings]
        : parsed.warnings;

    const finalState = state ?? serviceStateOf(parsed.design);
    const design = applyServiceState(parsed.design, finalState);

    const files: DesignFiles = { screens: {} };
    if (design.kind === 'artifact') files.entry = entryStatus;
    for (const screen of design.screens) {
      // Containment per reference: screen files are resolved inside the design folder, so a
      // junction/symlink under the design cannot point the stat at foreign files.
      const file = await resolveInside(dir, screenFileOf(screen.id).split('/')).catch(() => null);
      files.screens[screen.id] = file === null ? { exists: false, size: 0, mtime: null } : await fileStatus(file);
    }
    const pending = design.kind === 'artifact' ? !entryStatus.exists : !Object.values(files.screens).some((entry) => entry.exists);

    return {
      record: { slug, path: dir, design, state: finalState, extra: parsed.extra, pending, files, warnings },
      raw: parsed.raw,
      designText,
      stateFromDisk: state !== null,
    };
  };

  /** The agent-owned base for a minimal design.json the service creates (§6.1). */
  const agentPartOf = (design: DesignJson, updated: string): JsonObject => ({
    title: design.title,
    updated,
    // Safe: Viewport/Screen/DesignSystemStatus are plain JSON records by construction.
    viewports: design.viewports as unknown as JsonValue[],
    ...(design.kind === 'canvas' ? { screens: design.screens as unknown as JsonValue[] } : {}),
    designSystem: { confirmed: design.designSystem.confirmed },
  });

  /**
   * state.json first, then the design.json mirror (§6.3). `write` carries the service's own
   * agent-field writes (a user rename, the `updated` bump); `null` means reconcile mode:
   * rewrite only when a service-owned field actually differs, and never normalise formatting
   * otherwise — that is what keeps the watcher loop closed.
   */
  const writeStateAndMirror = async (slug: string, read: InternalRead, state: ServiceState, write: ServiceWrite | null): Promise<void> => {
    const dir = read.record.path;
    await writeFileAtomic(stateFileOf(dir), serializeJson(state as unknown as JsonValue)); // Safe: ServiceState is plain JSON.

    const designPath = path.join(dir, DESIGN_JSON_FILE);
    let text = read.designText;
    let raw = read.raw;
    // The agent may rewrite design.json at any moment: the mirror replaces the file only while
    // it still holds the text it was merged from; otherwise it re-merges from the fresh text.
    for (let attempt = 0; attempt < MIRROR_ATTEMPTS; attempt += 1) {
      let bytes: string;
      if (text === null) {
        // The file is missing: reconcile never invents one, but a service-side mutation
        // writes the minimal design.json (§6.1).
        if (write === null) return;
        bytes = serializeJson(mergeServiceFields(agentPartOf(read.record.design, write.updated ?? now().toISOString()), state, write));
      } else {
        if (raw === null) {
          // Unparseable: the agent may be mid-write. Never write over it (WP0 deviation 8);
          // state.json keeps the truth and the next watcher event retries.
          log.warn('store.design-json-unparseable', { slug, message: 'design.json is not valid JSON; the service left it alone.' });
          return;
        }
        if (write === null && !serviceFieldsDiffer(raw, state)) return;
        bytes = serializeJson(mergeServiceFields(raw, state, write ?? {}));
        if (bytes === text) return; // equal bytes → skip → no watch loop
      }
      if (await replaceFileIfUnchanged(designPath, text, bytes)) {
        if (write === null) log.info('store.design-json-remerged', { slug, message: 'Service-owned fields were restored into design.json.' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, MIRROR_RETRY_MS * (attempt + 1)));
      text = await readFile(designPath, 'utf8').catch(() => null);
      raw = text === null ? null : parseDesignJsonText(text, { kind: read.record.design.kind, fallbackTitle: slug, fallbackTime: read.record.design.created }).raw;
    }
    // Still changing: the agent's file stays as it is; state.json holds the truth and the
    // watcher's reconcile merges it once the agent is done.
    log.warn('store.design-json-busy', { slug, message: 'design.json kept changing or stayed locked; the mirror is merged on the next change.' });
  };

  const thumbOf = (slug: string): { state: ThumbState; key: string | null } => {
    try {
      return options.thumbnails?.peek(slug) ?? { state: 'unavailable', key: null };
    } catch {
      // WP2 not wired yet (main.ts placeholders throw): a missing thumb state is decorative,
      // the list must still answer.
      return { state: 'unavailable', key: null };
    }
  };

  const summaryOf = (record: DesignRecord): DesignSummary => ({
    slug: record.slug,
    kind: record.design.kind,
    title: record.design.title,
    created: record.design.created,
    updated: record.design.updated,
    pending: record.pending,
    screenCount: record.design.screens.length,
    viewports: record.design.viewports,
    sessionId: record.design.sessionId,
    openComments: record.design.comments.filter((comment) => comment.status === 'open').length,
    thumb: thumbOf(record.slug),
    warnings: record.warnings,
  });

  /** Cheap stat fingerprint deciding whether a cached summary is still valid. */
  const cacheKeyOf = async (dir: string): Promise<string> => {
    const parts: string[] = [];
    for (const relative of ['design.json', '.chamber/state.json', ENTRY_FILE, 'screens', 'assets', '.']) {
      const info = await stat(path.join(dir, relative)).catch(() => null);
      parts.push(info === null ? '-' : `${info.mtimeMs}:${info.size}`);
    }
    return parts.join('|');
  };

  const listCached = async (slug: string): Promise<DesignSummary> => {
    const dir = path.join(settings.root(), slug); // slug is pattern-validated above; stat only
    const key = await cacheKeyOf(dir);
    const cached = summaryCache.get(slug);
    if (cached !== undefined && cached.key === key) return { ...cached.summary, thumb: thumbOf(slug) };
    const read = await readInternal(slug);
    const summary = summaryOf(read.record);
    summaryCache.set(slug, { key, summary });
    return { ...summary, thumb: thumbOf(slug) };
  };

  const reconcile = async (slug: string): Promise<void> => {
    if (!isSlug(slug)) return;
    await withLock(slug, async () => {
      let read: InternalRead;
      try {
        read = await readInternal(slug);
      } catch (error) {
        // The folder vanished mid-event (deleted/trashed): nothing to merge.
        if (error instanceof ApiError && error.code === 'not-found') return;
        throw error;
      }
      const dir = read.record.path;
      let state = read.record.state;
      if (!read.stateFromDisk) {
        // state.json missing or corrupt → design.json is the only source: adopt its
        // service-owned fields (comments included) and rebuild state.json.
        state = serviceStateOf(read.record.design);
        await writeFileAtomic(stateFileOf(dir), serializeJson(state as unknown as JsonValue)); // Safe: ServiceState is plain JSON.
      }
      await writeStateAndMirror(slug, { ...read, record: { ...read.record, state } }, state, null);
    });
  };

  if (hub !== undefined) {
    hub.subscribe((event) => {
      const slug = event.slug;
      if (slug === null || (event.kind !== 'design' && event.kind !== 'added')) return;
      reconcile(slug).catch((error) => {
        log.warn('store.reconcile-failed', { slug, error: error instanceof Error ? error.message : String(error) });
      });
    });
  }

  const store: DesignStoreWithReconcile = {
    async dir(slug) {
      return designDir(slug);
    },

    async list(filter) {
      const root = settings.root();
      const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
        // A root that is not there yet lists as empty; one that refuses us (macOS privacy on
        // ~/Documents, a folder another user owns) says so instead of looking empty.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'EACCES') throw new ApiError('bad-path', folderErrorSentence(error, root));
        return null;
      });
      if (entries === null) return [];
      const slugs = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && isSlug(entry.name))
        .map((entry) => entry.name);
      const summaries: DesignSummary[] = [];
      for (const slug of slugs) {
        if (!(await isDesignFolder(path.join(root, slug)))) continue; // the user's own folder, not a design
        try {
          summaries.push(await listCached(slug));
        } catch (error) {
          // One broken folder must not blank the whole list (loud in the log, graceful on screen).
          log.warn('store.list-entry-failed', { slug, error: error instanceof Error ? error.message : String(error) });
        }
      }
      const q = filter?.q?.trim().toLowerCase();
      return summaries
        .filter((summary) => (filter?.kind === undefined || summary.kind === filter.kind) && (q === undefined || q === '' || summary.title.toLowerCase().includes(q) || summary.slug.includes(q)))
        .sort((a, b) => (a.updated === b.updated ? a.slug.localeCompare(b.slug) : b.updated.localeCompare(a.updated)));
    },

    async get(slug) {
      const read = await readInternal(slug);
      return read.record;
    },

    async create(input) {
      const root = settings.root();
      try {
        await mkdir(root, { recursive: true });
      } catch (error) {
        throw new ApiError('bad-path', folderErrorSentence(error, root));
      }
      const brief = typeof input.brief === 'string' ? input.brief.slice(0, BRIEF_MAX) : '';
      const requestedTitle = typeof input.title === 'string' ? input.title.trim() : '';
      const title = (requestedTitle.length >= 1 ? requestedTitle : firstLineOf(brief) ?? 'Untitled design').slice(0, TITLE_MAX);

      // '\0create' can never be a slug, so no design's own lock serialises with creates.
      const record = await withLock('\0create', async () => {
        // One global create lock: slug allocation + mkdir must be atomic across concurrent
        // creates, or two titles folding to the same slug could race into one folder.
        const slug = await uniqueSlug(slugify(title), async (candidate) => isDirectory(path.join(root, candidate)));
        const dir = await resolveInside(root, [slug]);
        if (await isDirectory(dir)) throw new ApiError('conflict', 'A design with that name appeared while this one was being created.');
        await mkdir(dir, { recursive: true });
        const nowIso = now().toISOString();
        const { state, json } = createDesignDocument({
          kind: input.kind,
          title,
          brief,
          sessionId: input.sessionId ?? null,
          projectDirectory: input.projectDirectory ?? null,
          preset: input.preset ?? null,
          now: nowIso,
        });
        await writeFileAtomic(stateFileOf(dir), serializeJson(state as unknown as JsonValue)); // Safe: ServiceState is plain JSON.
        await writeFileAtomic(path.join(dir, DESIGN_JSON_FILE), serializeJson(json));
        if (input.kind === 'artifact' && typeof input.html === 'string') {
          await writeFileAtomic(path.join(dir, ENTRY_FILE), input.html);
        }
        return readInternal(slug);
      });

      // WP3 registers the RULES.md hook; a failing hook is logged and never undoes the create.
      for (const hook of [...hooks]) {
        try {
          await hook(record.record);
        } catch (error) {
          log.warn('store.create-hook-failed', { slug: record.record.slug, error: error instanceof Error ? error.message : String(error) });
        }
      }
      hub?.emit({ slug: record.record.slug, kind: 'added' });
      return record.record;
    },

    async patch(slug, patchBody: PatchDesignBody) {
      const nowIso = now().toISOString();
      const read = await withLock(slug, async () => {
        const current = await readInternal(slug);
        let state = current.record.state;
        if (patchBody.sessionId !== undefined) state = { ...state, sessionId: patchBody.sessionId };
        if (patchBody.projectDirectory !== undefined) state = { ...state, projectDirectory: patchBody.projectDirectory };
        const write: ServiceWrite = { updated: nowIso };
        if (patchBody.title !== undefined) write.title = patchBody.title;
        await writeStateAndMirror(slug, current, state, write);
        return readInternal(slug);
      });
      hub?.emit({ slug, kind: 'design' });
      return read.record;
    },

    async trash(slug) {
      const trashedTo = await withLock(slug, async () => {
        const dir = await designDir(slug);
        const trashRoot = await resolveInside(settings.root(), ['.trash']);
        await mkdir(trashRoot, { recursive: true });
        const stamp = timestampOf(now());
        let target = path.join(trashRoot, `${slug}-${stamp}`);
        for (let suffix = 2; await exists(target); suffix += 1) target = path.join(trashRoot, `${slug}-${stamp}-${suffix}`);
        await rename(dir, target);
        summaryCache.delete(slug);
        return target;
      });
      hub?.emit({ slug, kind: 'removed' });
      return trashedTo;
    },

    async addComment(slug, input: CreateCommentBody) {
      const nowIso = now().toISOString();
      const result = await withLock(slug, async () => {
        const read = await readInternal(slug);
        const state = read.record.state;
        if (state.comments.length >= COMMENTS_MAX) {
          throw new ApiError('conflict', `This design already carries ${COMMENTS_MAX} comments — resolve or delete some before adding more.`);
        }
        const comment: Comment = {
          id: mintCommentId(new Set(state.comments.map((entry) => entry.id))),
          screen: input.screen,
          viewport: input.viewport,
          anchor: input.anchor,
          body: input.body,
          status: 'open',
          created: nowIso,
          sentAt: null,
          sentVersion: null,
        };
        const next: ServiceState = { ...state, comments: [...state.comments, comment] };
        await writeStateAndMirror(slug, read, next, { updated: nowIso });
        return comment;
      });
      hub?.emit({ slug, kind: 'comments' });
      return result;
    },

    async updateComment(slug, id, patchBody: PatchCommentBody) {
      const nowIso = now().toISOString();
      const result = await withLock(slug, async () => {
        const read = await readInternal(slug);
        const state = read.record.state;
        const index = state.comments.findIndex((comment) => comment.id === id);
        if (index === -1) throw new ApiError('not-found', 'That comment does not exist.');
        const current = state.comments[index] as Comment; // Safe: findIndex answered a valid index.
        const updated: Comment = {
          ...current,
          ...(patchBody.body !== undefined ? { body: patchBody.body } : {}),
          ...(patchBody.status !== undefined ? { status: patchBody.status } : {}),
        };
        const comments = state.comments.map((comment, position) => (position === index ? updated : comment));
        await writeStateAndMirror(slug, read, { ...state, comments }, { updated: nowIso });
        return updated;
      });
      hub?.emit({ slug, kind: 'comments' });
      return result;
    },

    async deleteComment(slug, id) {
      const nowIso = now().toISOString();
      await withLock(slug, async () => {
        const read = await readInternal(slug);
        const state = read.record.state;
        const comments = state.comments.filter((comment) => comment.id !== id);
        if (comments.length === state.comments.length) throw new ApiError('not-found', 'That comment does not exist.');
        await writeStateAndMirror(slug, read, { ...state, comments }, { updated: nowIso });
      });
      hub?.emit({ slug, kind: 'comments' });
    },

    async markSent(slug, ids, version) {
      const nowIso = now().toISOString();
      const marked = await withLock(slug, async () => {
        const read = await readInternal(slug);
        const state = read.record.state;
        const wanted = new Set(ids);
        const found: Comment[] = [];
        const comments = state.comments.map((comment) => {
          if (!wanted.has(comment.id)) return comment;
          const sent: Comment = { ...comment, status: 'sent', sentAt: nowIso, sentVersion: version };
          found.push(sent);
          return sent;
        });
        if (found.length > 0) await writeStateAndMirror(slug, read, { ...state, comments }, { updated: nowIso });
        return found;
      });
      if (marked.length > 0) hub?.emit({ slug, kind: 'comments' });
      return marked;
    },

    onCreate(hook) {
      hooks.add(hook);
      return () => hooks.delete(hook);
    },

    reconcile,
  };
  return store;
};

const exists = async (target: string): Promise<boolean> => {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
};

/** First non-empty line of a brief, or null — the fallback title of a design created without one. */
const firstLineOf = (brief: string): string | null => {
  const line = brief
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return line === undefined || line === '' ? null : line.slice(0, TITLE_MAX);
};
