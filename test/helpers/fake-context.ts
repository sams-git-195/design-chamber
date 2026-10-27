// An in-memory `ServiceContext` for lane tests (WP2/WP3 code against it before WP1 lands).
//
// Real enough to be useful: a tmp root, a working change hub, a read-only store that reads
// design folders from disk through the real design.json parser, seedable uploads and an
// outbox. Anything a test needs beyond that is passed in `overrides`; un-faked methods throw
// "not faked" so a test never silently depends on behaviour it did not set up.

import { randomUUID } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

import type { ChangesResponse } from '../../src/shared/api.ts';
import { applyServiceState, normalizeServiceState, parseDesignJsonText, screenFileOf, serviceStateOf, ENTRY_FILE } from '../../src/shared/design-json.ts';
import { SLUG_PATTERN } from '../../src/shared/limits.ts';
import type { ChangeEvent, DesignFiles, DesignKind, DesignSummary, FileStatus, Outbox, SettingsFile } from '../../src/shared/types.ts';
import {
  unavailable,
  type ChangeHub,
  type DesignRecord,
  type DesignStore,
  type Logger,
  type OutboxStore,
  type ServiceContext,
  type SettingsStore,
  type UploadStore,
} from '../../src/service/context.ts';
import { ApiError } from '../../src/service/http.ts';

export type LogLine = { level: 'info' | 'warn' | 'error'; event: string; fields?: Readonly<Record<string, unknown>> };

export type FakeContext = ServiceContext & {
  logs: LogLine[];
  /** Every event emitted on the hub, in order. */
  events: ChangeEvent[];
  /** Store a complete upload; answers its id for `uploads.take`. */
  seedUpload(text: string): string;
  /** Run the `onDispose` callbacks (reverse order). */
  dispose(): Promise<void>;
};

export type FakeContextOptions = {
  /** Designs root (use `createTmpRoot`). */
  root: string;
  /** Defaults to the repository root (so `rules/` is the real one). */
  packageRoot?: string;
  settings?: Partial<SettingsFile>;
  overrides?: Partial<ServiceContext>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');

/** `implemented`, with every other method throwing "not faked" (an object spread of a Proxy would copy nothing). */
const partial = <T extends object>(name: string, implemented: Partial<T>): T => {
  const missing = unavailable<T>(name);
  // Safe: known keys come from `implemented`; every other key yields a function that throws.
  return new Proxy(implemented, {
    get: (target, property, receiver) => (Reflect.has(target, property) ? Reflect.get(target, property, receiver) : Reflect.get(missing, property)),
  }) as T;
};

const fileStatus = async (file: string): Promise<FileStatus> => {
  try {
    const info = await stat(file);
    return { exists: info.isFile(), size: info.size, mtime: info.mtime.toISOString() };
  } catch {
    return { exists: false, size: 0, mtime: null };
  }
};

const createHub = (epoch: string, events: ChangeEvent[]): ChangeHub => {
  let seq = 0;
  const listeners = new Set<(event: ChangeEvent) => void>();
  const answer = (since: number, clientEpoch: string): ChangesResponse => {
    if (clientEpoch !== epoch) return { epoch, seq, reset: true, events: [] };
    return { epoch, seq, reset: false, events: events.filter((event) => event.seq > since) };
  };
  return {
    epoch,
    seq: () => seq,
    emit(input) {
      seq += 1;
      const event: ChangeEvent = { seq, slug: input.slug, kind: input.kind, ...(input.files ? { files: input.files } : {}) };
      events.push(event);
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    waitFor(since, clientEpoch, waitMs, signal) {
      const now = answer(since, clientEpoch);
      if (now.reset || now.events.length > 0 || waitMs <= 0) return Promise.resolve(now);
      return new Promise((resolve) => {
        const finish = (): void => {
          clearTimeout(timer);
          listeners.delete(onEvent);
          signal?.removeEventListener('abort', finish);
          resolve(answer(since, clientEpoch));
        };
        const onEvent = (): void => finish();
        const timer = setTimeout(finish, waitMs);
        listeners.add(onEvent);
        signal?.addEventListener('abort', finish);
      });
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

const createStore = (settings: SettingsStore): DesignStore => {
  const dir = async (slug: string): Promise<string> => {
    if (!SLUG_PATTERN.test(slug)) throw new ApiError('bad-slug', 'That is not a design name.');
    const folder = path.join(settings.root(), slug);
    const info = await stat(folder).catch(() => null);
    if (!info?.isDirectory()) throw new ApiError('not-found', 'That design does not exist.');
    return folder;
  };

  const get = async (slug: string): Promise<DesignRecord> => {
    const folder = await dir(slug);
    const folderTime = (await stat(folder)).mtime.toISOString();
    const stateText = await readFile(path.join(folder, '.chamber', 'state.json'), 'utf8').catch(() => null);
    const state = stateText === null ? null : normalizeServiceState(JSON.parse(stateText));
    const designText = await readFile(path.join(folder, 'design.json'), 'utf8').catch(() => null);
    const hasEntry = (await fileStatus(path.join(folder, ENTRY_FILE))).exists;
    const kind: DesignKind = state?.kind ?? (hasEntry ? 'artifact' : 'canvas');
    const parsed = parseDesignJsonText(designText ?? '{}', { kind, fallbackTitle: slug, fallbackTime: folderTime });
    const warnings = designText === null ? [{ code: 'no-design-json', message: 'This design has no design.json yet.' }, ...parsed.warnings] : parsed.warnings;
    const finalState = state ?? serviceStateOf(parsed.design);
    const design = applyServiceState(parsed.design, finalState);
    const files: DesignFiles = { screens: {} };
    if (design.kind === 'artifact') files.entry = await fileStatus(path.join(folder, ENTRY_FILE));
    for (const screen of design.screens) files.screens[screen.id] = await fileStatus(path.join(folder, ...screenFileOf(screen.id).split('/')));
    const pending = design.kind === 'artifact' ? !files.entry?.exists : !Object.values(files.screens).some((file) => file.exists);
    return { slug, path: folder, design, state: finalState, extra: parsed.extra, pending, files, warnings };
  };

  return partial<DesignStore>('fake store — pass it in overrides', {
    dir,
    get,
    async list() {
      const entries = await readdir(settings.root(), { withFileTypes: true }).catch(() => []);
      const records = await Promise.all(
        entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && SLUG_PATTERN.test(entry.name)).map((entry) => get(entry.name)),
      );
      return records.map(
        (record): DesignSummary => ({
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
          thumb: { state: 'unavailable', key: null },
          warnings: record.warnings,
        }),
      );
    },
    onCreate: () => () => undefined,
  });
};

export const createFakeContext = (options: FakeContextOptions): FakeContext => {
  const logs: LogLine[] = [];
  const events: ChangeEvent[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  const epoch = randomUUID();

  const log: Logger = {
    info: (event, fields) => void logs.push({ level: 'info', event, fields }),
    warn: (event, fields) => void logs.push({ level: 'warn', event, fields }),
    error: (event, fields) => void logs.push({ level: 'error', event, fields }),
  };

  let file: SettingsFile = { version: 1, root: options.root, ...options.settings };
  const rootListeners = new Set<(root: string, previous: string) => void>();
  const settings: SettingsStore = {
    root: () => file.root ?? options.root,
    defaultRoot: () => options.root,
    read: () => file,
    async update(patch) {
      const previous = settings.root();
      const next: SettingsFile = { ...file };
      if (patch.root !== undefined) {
        if (patch.root === null) delete next.root;
        else next.root = patch.root;
      }
      if (patch.chromePath !== undefined) {
        if (patch.chromePath === null) delete next.chromePath;
        else next.chromePath = patch.chromePath;
      }
      file = next;
      if (settings.root() !== previous) for (const listener of rootListeners) listener(settings.root(), previous);
      return file;
    },
    onRootChange(listener) {
      rootListeners.add(listener);
      return () => rootListeners.delete(listener);
    },
  };

  const uploadsById = new Map<string, string>();
  const uploads = partial<UploadStore>('fake uploads — use seedUpload or overrides', {
    take(id) {
      const text = uploadsById.get(id);
      if (text === undefined) throw new ApiError('not-found', 'That upload does not exist or has expired.');
      uploadsById.delete(id);
      return text;
    },
  });

  let slot: Outbox | null = null;
  const outbox: OutboxStore = {
    get: () => slot,
    put: (input) => (slot = { ...input, created: new Date().toISOString() }),
    take: () => {
      const taken = slot;
      slot = null;
      return taken;
    },
  };

  const base: ServiceContext = {
    packageRoot: options.packageRoot ?? REPO_ROOT,
    version: '0.0.0-test',
    epoch,
    log,
    settings,
    store: createStore(settings),
    hub: createHub(epoch, events),
    uploads,
    outbox,
    renders: unavailable('fake renders — pass it in overrides'),
    thumbnails: { peek: () => ({ state: 'unavailable', key: null }) },
    onDispose: (fn) => void disposers.push(fn),
  };

  return {
    ...base,
    ...options.overrides,
    logs,
    events,
    seedUpload(text) {
      const id = `u_${randomUUID().replace(/-/g, '')}`;
      uploadsById.set(id, text);
      return id;
    },
    async dispose() {
      for (const fn of disposers.reverse()) await fn();
    },
  };
};
