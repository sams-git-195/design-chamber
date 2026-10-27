// The service's composition contract (docs/SPEC.md §9.7). Every lane's routes receive one
// `ServiceContext`; each interface below is implemented by the lane named on it and faked in
// tests by `test/helpers/fake-context.ts`. Modules throw `ApiError` for user-facing failures.

import type {
  ChangesResponse,
  CreateCommentBody,
  CreateDesignBody,
  PatchCommentBody,
  PatchDesignBody,
  PutOutboxBody,
  PutSettingsBody,
  PutUploadChunkResponse,
  RenderMeta,
  RenderQuery,
} from '../shared/api.ts';
import type {
  ChangeEvent,
  ChangeKind,
  Comment,
  DesignFiles,
  DesignJson,
  DesignKind,
  DesignSummary,
  DesignWarning,
  JsonObject,
  Outbox,
  ServiceState,
  SettingsFile,
  ThumbState,
} from '../shared/types.ts';
import { ApiError } from './http.ts';

// ---- Logging ----

export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

/** Structured log lines (one JSON object per line, stderr). Never pass the token, file contents, or personal data. */
export type Logger = {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
};

export const createLogger = (write: (line: string) => void = (line) => process.stderr.write(line)): Logger => {
  const emit = (level: 'info' | 'warn' | 'error', event: string, fields?: LogFields): void => {
    write(`${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`);
  };
  return {
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
};

// ---- WP1: settings and root (§6.5, §9.2) ----

export type SettingsStore = {
  /** Absolute current designs root (the default when unset). */
  root(): string;
  /** `os.homedir()/Documents/Designs`. */
  defaultRoot(): string;
  /** The settings file as last read or written (cached; corrupt files read as `{ version: 1 }`). */
  read(): SettingsFile;
  /** Validate and persist (atomic). A root change pushes the old root to `previousRoots`, never moves files, and notifies `onRootChange`. 400 `bad-path` on an unusable path. */
  update(patch: PutSettingsBody): Promise<SettingsFile>;
  onRootChange(listener: (root: string, previous: string) => void): () => void;
};

// ---- WP1: designs store (§6.3, §9.3) ----

/** One design as the store knows it: the merged view (state.json over design.json). */
export type DesignRecord = {
  slug: string;
  /** Absolute folder, already contained under the root. */
  path: string;
  design: DesignJson;
  state: ServiceState;
  /** Unknown top-level design.json keys. */
  extra: JsonObject;
  pending: boolean;
  files: DesignFiles;
  warnings: DesignWarning[];
};

export type DesignFilter = { q?: string; kind?: DesignKind };

/** `POST /designs` input after validation; `html` already joined from an upload when one was used. */
export type CreateDesignInput = Omit<CreateDesignBody, 'uploadId'>;

export type DesignStore = {
  /** Absolute folder of an existing design. Throws `bad-slug` (pattern or containment) or `not-found`. */
  dir(slug: string): Promise<string>;
  list(filter?: DesignFilter): Promise<DesignSummary[]>;
  get(slug: string): Promise<DesignRecord>;
  /** Unique slug from the title, folder, state.json, design.json, optional index.html; then runs `onCreate` hooks. */
  create(input: CreateDesignInput): Promise<DesignRecord>;
  patch(slug: string, patch: PatchDesignBody): Promise<DesignRecord>;
  /** Moves the folder to `.trash/`; answers the new absolute path. */
  trash(slug: string): Promise<string>;
  addComment(slug: string, input: CreateCommentBody): Promise<Comment>;
  updateComment(slug: string, id: string, patch: PatchCommentBody): Promise<Comment>;
  deleteComment(slug: string, id: string): Promise<void>;
  markSent(slug: string, ids: string[], version: number | null): Promise<Comment[]>;
  /** WP3 registers one hook that writes `.chamber/RULES.md`. A failing hook is logged, never undoes the create. */
  onCreate(hook: (record: DesignRecord) => Promise<void>): () => void;
};

// ---- WP1: change hub (§9.4) ----

export type ChangeHub = {
  /** Same as `ServiceContext.epoch`. */
  readonly epoch: string;
  /** Highest seq emitted so far (0 before any event). */
  seq(): number;
  emit(event: { slug: string | null; kind: ChangeKind; files?: string[] }): ChangeEvent;
  /** Events after `since`, or `reset` when `epoch` differs or `since` left the ring. Resolves early on the next event, at `waitMs` (≤ `CHANGES_WAIT_MAX_MS`), or when `signal` aborts. */
  waitFor(since: number, epoch: string, waitMs: number, signal?: AbortSignal): Promise<ChangesResponse>;
  /** In-process listeners (render cache, thumbnails, versions, design.json merge). */
  subscribe(listener: (event: ChangeEvent) => void): () => void;
};

// ---- WP1: uploads and outbox (§7) ----

export type UploadStore = {
  /** Throws `too-large` over `UPLOAD_TOTAL_MAX`, `conflict` with `UPLOADS_OPEN_MAX` open. */
  create(total: number): string;
  /** Chunks arrive in index order; throws `not-found` (unknown/expired), `conflict` (out of order), `too-large` (beyond total). */
  put(id: string, index: number, data: string): PutUploadChunkResponse;
  /** The complete text, once; the upload is gone afterwards. Throws `not-found` or `conflict` (incomplete). */
  take(id: string): string;
};

export type OutboxStore = {
  get(): Outbox | null;
  put(input: PutOutboxBody): Outbox;
  /** Answer the slot and clear it (exactly-once delivery). */
  take(): Outbox | null;
};

// ---- WP2: rendering and thumbnails (§9.5) ----

export type RenderService = {
  /** Bundle (or reuse the cached bundle of) a design document. 404 unknown screen/version, 413 over `RENDER_DOC_MAX_BYTES`. */
  render(slug: string, query: RenderQuery): Promise<RenderMeta>;
  /** Raw text chunk `n` of a cached render. Throws `stale` when the key was evicted. */
  chunk(key: string, n: number): string;
};

export type ThumbnailService = {
  /** Cheap, synchronous view for list summaries; never starts work. */
  peek(slug: string): { state: ThumbState; key: string | null };
};

// ---- The context ----

export type ServiceContext = {
  /** Folder holding package.json, dist/ and rules/ (two levels above dist/service/main.js). */
  packageRoot: string;
  /** package.json version. */
  version: string;
  /** Random per process; the change hub and /health use it. */
  epoch: string;
  log: Logger;
  settings: SettingsStore;
  store: DesignStore;
  hub: ChangeHub;
  uploads: UploadStore;
  outbox: OutboxStore;
  renders: RenderService;
  thumbnails: ThumbnailService;
  /** Register teardown (watchers, timers, child processes); run on shutdown in reverse order. */
  onDispose(fn: () => void | Promise<void>): void;
};

/**
 * Placeholder for a module a lane has not delivered yet: every method throws
 * `internal` with a sentence the UI can show. Used by main.ts until integration.
 */
export const unavailable = <T extends object>(name: string): T =>
  // Safe: callers only reach the methods of T; each one throws before returning anything.
  new Proxy({} as T, {
    get(_target, property) {
      if (property === 'then' || typeof property === 'symbol') return undefined;
      return () => {
        throw new ApiError('internal', `This part of Design Chamber (${name}) is not built yet.`);
      };
    },
  });
