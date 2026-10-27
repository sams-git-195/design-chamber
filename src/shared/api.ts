// The service HTTP API contract (docs/SPEC.md §7): every route's path params, query,
// request body and response. The service router (`src/service/http.ts`) and the guest
// client (`src/guest/service-client.ts`) are both typed from `ApiRoutes`.
//
// Wire rules: JSON in and out unless a route is in `RAW_TEXT_ROUTES`; query values are
// strings (F7); every request carries the bearer token (the host adds it); errors are
// `ApiErrorBody` with the status from `API_ERROR_STATUS`.

import type {
  AnchorState,
  BrowserSource,
  Comment,
  CommentAnchor,
  CommentStatus,
  DesignChip,
  DesignFiles,
  DesignJson,
  DesignKind,
  DesignSummary,
  DesignWarning,
  ChangeEvent,
  ExportFormat,
  IsoDate,
  Outbox,
  Preset,
  ThumbState,
  VersionFileChange,
  VersionSummary,
} from './types.ts';

// ---- Errors ----

export type ApiErrorCode =
  | 'unauthorized'
  | 'bad-request'
  | 'bad-path'
  | 'bad-slug'
  | 'not-found'
  | 'conflict'
  | 'stale'
  | 'too-large'
  | 'no-html'
  | 'invalid'
  | 'internal';

export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  unauthorized: 401,
  'bad-request': 400,
  'bad-path': 400,
  'bad-slug': 400,
  'not-found': 404,
  conflict: 409,
  stale: 409,
  'too-large': 413,
  'no-html': 422,
  invalid: 422,
  internal: 500,
};

/** Every non-2xx answer. `message` is a user-facing sentence the UI may show as is. */
export type ApiErrorBody = { error: ApiErrorCode; message: string };

export const isApiErrorCode = (value: unknown): value is ApiErrorCode =>
  typeof value === 'string' && Object.hasOwn(API_ERROR_STATUS, value);

// ---- Bodies and answers, in §7 table order ----

export type HealthResponse = { ok: true; version: string; epoch: string };

/** A root the user switched away from; designs there are never moved [§9.2]. */
export type PreviousRoot = { path: string; exists: boolean; designCount: number };

export type SettingsResponse = {
  /** Absolute current designs root. */
  root: string;
  /** `~/Documents/Designs` on this machine. */
  defaultRoot: string;
  /** Newest first, ≤ `PREVIOUS_ROOTS_MAX`. */
  previousRoots: PreviousRoot[];
  rootExists: boolean;
  chrome: { path: string | null; source: BrowserSource };
  /** Where exports are written (`~/Downloads`, or `<root>/.exports` when missing). */
  downloadsDir: string;
};

/** `null` resets a field to its default. 400 `bad-path` for a relative path, a filesystem root, a folder inside the extension package, or one that cannot be created. */
export type PutSettingsBody = { root?: string | null; chromePath?: string | null };

export type ChangesQuery = {
  /** Last `seq` the client has seen; `0` on the first call. */
  since: string;
  /** Epoch the client last saw; empty on the first call (answers `reset:true`). */
  epoch: string;
  /** Long-poll wait in ms, ≤ `CHANGES_WAIT_MAX_MS`; `0` answers at once. */
  wait?: string;
};

export type ChangesResponse = {
  epoch: string;
  /** Highest `seq` emitted so far; pass it back as `since`. */
  seq: number;
  /** The epoch changed or `since` fell out of the ring: refetch everything. */
  reset: boolean;
  events: ChangeEvent[];
};

export type DesignsQuery = { q?: string; kind?: DesignKind };
export type DesignListResponse = { root: string; designs: DesignSummary[] };

export type CreateDesignBody = {
  kind: DesignKind;
  title?: string;
  brief?: string;
  preset?: string | null;
  projectDirectory?: string | null;
  sessionId?: string | null;
  /** Artifact only: initial `index.html`, ≤ `CREATE_INLINE_HTML_MAX`; larger HTML uses `uploadId`. */
  html?: string;
  /** Artifact only: a completed upload holding the initial `index.html`. */
  uploadId?: string;
};
export type CreateDesignResponse = { slug: string; path: string; design: DesignJson };

export type DesignDetailResponse = {
  slug: string;
  /** Absolute design folder. */
  path: string;
  design: DesignJson;
  pending: boolean;
  files: DesignFiles;
  warnings: DesignWarning[];
};

/** `title` writes design.json's title (a user rename). */
export type PatchDesignBody = { title?: string; sessionId?: string | null; projectDirectory?: string | null };
export type PatchDesignResponse = { design: DesignJson };

/** Moves the folder to `<root>/.trash/<slug>-<yyyymmddhhmmss>/`. */
export type DeleteDesignResponse = { trashedTo: string };

export type CreateCommentBody = { screen: string | null; viewport: string; anchor: CommentAnchor; body: string };
export type CommentResponse = { comment: Comment };
export type PatchCommentBody = { body?: string; status?: CommentStatus };
export type OkResponse = { ok: true };
export type MarkSentBody = { ids: string[]; version: number | null };
export type MarkSentResponse = { comments: Comment[] };

/** `total` = length (UTF-16 code units) of the whole text, ≤ `UPLOAD_TOTAL_MAX`. TTL `UPLOAD_TTL_MS`, ≤ `UPLOADS_OPEN_MAX` open. */
export type CreateUploadBody = { total: number };
export type CreateUploadResponse = { uploadId: string };
/** Chunk `:index` (0-based, in order); `data` ≤ `UPLOAD_CHUNK_MAX_CHARS` after `JSON.stringify`. */
export type PutUploadChunkBody = { data: string };
/** `received` = characters stored so far; `complete` once it equals `total`. */
export type PutUploadChunkResponse = { received: number; complete: boolean };

export type PutOutboxBody = { sessionId: string; slug: string; text: string; commentIds: string[]; version: number | null };
/** GET reads the slot, PUT replaces it, DELETE takes it (answers what was there, then clears — exactly-once delivery). */
export type OutboxResponse = { outbox: Outbox | null };

export type RenderQuery = { screen?: string; version?: string };
export type RenderMeta = {
  /** Render key: sha256 of the render inputs. */
  key: string;
  /** Number of `GET /render/chunk` calls needed (n = 0..chunks-1). */
  chunks: number;
  /** UTF-8 bytes of the whole document. */
  bytes: number;
  title: string;
  /** Relative references that point at files that do not exist. */
  missing: string[];
  /** References refused: outside the design folder, module imports, `<object data>`. */
  blocked: string[];
  /** Remote URLs left untouched (the host CSP blocks them). */
  external: string[];
  warnings: DesignWarning[];
};
export type RenderChunkQuery = { key: string; n: string };
/** Raw text, ≤ `RENDER_CHUNK_MAX_BYTES` UTF-8 bytes. 409 `stale` when the key was evicted. */
export type RenderChunkResponse = string;

export type SourceQuery = { screen?: string };
export type SourceResponse = { text: string; bytes: number };

export type ThumbnailResponse = {
  state: ThumbState;
  key: string | null;
  /** Base64 PNG, present when `state` is `ready`. */
  png?: string;
  width?: number;
  height?: number;
  /** User-facing reason when `failed` or `unavailable`. */
  message?: string;
};
export type ThumbnailRefreshResponse = { state: ThumbState };

export type VersionListResponse = { versions: VersionSummary[]; currentTreeHash: string; dirty: boolean };
export type CreateVersionBody = { reason: 'turn' | 'manual'; sessionId?: string | null; label?: string };
/** `null` = nothing changed since the newest version. */
export type CreateVersionResponse = { created: VersionSummary | null };
export type TurnSnapshotBody = { sessionId: string };
export type TurnSnapshotResponse = { created: { slug: string; id: string }[] };
/** `against`: `current` (default) or a version id. */
export type VersionDiffQuery = { against?: string };
export type VersionDiffResponse = { files: { path: string; change: VersionFileChange }[] };
export type RestoreVersionResponse = { restorePoint: VersionSummary | null; restored: VersionSummary };

/** `screen`: canvas single-file export only; default the first screen. */
export type ExportBody = { format: ExportFormat; screen?: string };
export type ExportResponse = { path: string; bytes: number; format: ExportFormat };

/** `path` must be an export path issued this run, or a design folder. */
export type RevealBody = { path: string };

export type PresetsResponse = { presets: Preset[] };

export type ChipBody = {
  kind: DesignKind;
  brief: string;
  preset?: string | null;
  projectDirectory?: string | null;
  sessionId?: string | null;
};
export type ChipResponse = { slug: string; chip: DesignChip };

export type PromptBody = {
  purpose: 'revision' | 'continue';
  commentIds?: string[];
  /** Revision only: how the page found each pinned element (from `anchoring.ts`), so the prompt can flag moved or missing elements. */
  anchorStates?: Record<string, AnchorState>;
};
export type PromptResponse = {
  /** Revision: ≤ `REVISION_TEXT_MAX`. Continue: a short resume message. */
  text: string;
  /** Comments included in `text`. */
  commentIds: string[];
  /** Requested comments left out by the length cap; they stay `open` ("K of N sent"). */
  omitted: string[];
  /** Context chip for `startSession`. */
  chip: DesignChip;
};

export type FromMessageBody = {
  /** Completed upload holding the message text. */
  uploadId: string;
  sessionId: string;
  sessionTitle: string;
  messageId: string;
  directory: string | null;
  /** Leave an open request for the rail (`DELETE /open-request`): the background action opens the panel next. */
  open?: boolean;
};
/** 422 `no-html` when the message has no HTML code block. */
export type FromMessageResponse = { slug: string; title: string };

/** A design the rail should open as soon as it is up; taken once, kept `OPEN_REQUEST_TTL_MS`. */
export type OpenRequest = { slug: string; created: IsoDate };
export type OpenRequestResponse = { request: OpenRequest | null };

// ---- The route table ----

type Route<Query, Body, Response> = { query: Query; body: Body; response: Response };
type NoQuery = Record<never, string>;

export interface ApiRoutes {
  'GET /health': Route<NoQuery, undefined, HealthResponse>;

  // WP1 — service core
  'GET /settings': Route<NoQuery, undefined, SettingsResponse>;
  'PUT /settings': Route<NoQuery, PutSettingsBody, SettingsResponse>;
  'GET /changes': Route<ChangesQuery, undefined, ChangesResponse>;
  'GET /designs': Route<DesignsQuery, undefined, DesignListResponse>;
  'POST /designs': Route<NoQuery, CreateDesignBody, CreateDesignResponse>;
  'GET /designs/:slug': Route<NoQuery, undefined, DesignDetailResponse>;
  'PATCH /designs/:slug': Route<NoQuery, PatchDesignBody, PatchDesignResponse>;
  'DELETE /designs/:slug': Route<NoQuery, undefined, DeleteDesignResponse>;
  'POST /designs/:slug/comments': Route<NoQuery, CreateCommentBody, CommentResponse>;
  'PATCH /designs/:slug/comments/:id': Route<NoQuery, PatchCommentBody, CommentResponse>;
  'DELETE /designs/:slug/comments/:id': Route<NoQuery, undefined, OkResponse>;
  'POST /designs/:slug/comments/mark-sent': Route<NoQuery, MarkSentBody, MarkSentResponse>;
  'POST /uploads': Route<NoQuery, CreateUploadBody, CreateUploadResponse>;
  'PUT /uploads/:id/:index': Route<NoQuery, PutUploadChunkBody, PutUploadChunkResponse>;
  'GET /outbox': Route<NoQuery, undefined, OutboxResponse>;
  'PUT /outbox': Route<NoQuery, PutOutboxBody, OutboxResponse>;
  'DELETE /outbox': Route<NoQuery, undefined, OutboxResponse>;

  // WP2 — rendering, versions, export, thumbnails
  'GET /designs/:slug/render': Route<RenderQuery, undefined, RenderMeta>;
  'GET /designs/:slug/render/chunk': Route<RenderChunkQuery, undefined, RenderChunkResponse>;
  'GET /designs/:slug/source': Route<SourceQuery, undefined, SourceResponse>;
  'GET /designs/:slug/thumbnail': Route<NoQuery, undefined, ThumbnailResponse>;
  'POST /designs/:slug/thumbnail/refresh': Route<NoQuery, undefined, ThumbnailRefreshResponse>;
  'GET /designs/:slug/versions': Route<NoQuery, undefined, VersionListResponse>;
  'POST /designs/:slug/versions': Route<NoQuery, CreateVersionBody, CreateVersionResponse>;
  'POST /versions/turn': Route<NoQuery, TurnSnapshotBody, TurnSnapshotResponse>;
  'GET /designs/:slug/versions/:vid/diff': Route<VersionDiffQuery, undefined, VersionDiffResponse>;
  'POST /designs/:slug/versions/:vid/restore': Route<NoQuery, undefined, RestoreVersionResponse>;
  'POST /designs/:slug/export': Route<NoQuery, ExportBody, ExportResponse>;
  'POST /reveal': Route<NoQuery, RevealBody, OkResponse>;

  // WP3 — agent instructions
  'GET /presets': Route<NoQuery, undefined, PresetsResponse>;
  'POST /chip': Route<NoQuery, ChipBody, ChipResponse>;
  'POST /designs/:slug/prompt': Route<NoQuery, PromptBody, PromptResponse>;
  'POST /artifacts/from-message': Route<NoQuery, FromMessageBody, FromMessageResponse>;
  'DELETE /open-request': Route<NoQuery, undefined, OpenRequestResponse>;
}

export type RouteKey = keyof ApiRoutes;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type RouteMethod<K extends RouteKey> = K extends `${infer M extends HttpMethod} ${string}` ? M : never;
export type RoutePattern<K extends RouteKey> = K extends `${HttpMethod} ${infer P}` ? P : never;

type ParamNames<S extends string> = S extends `${string}:${infer Name}/${infer Rest}`
  ? Name | ParamNames<`/${Rest}`>
  : S extends `${string}:${infer Name}`
    ? Name
    : never;

/** Path params of a route, derived from its pattern (`/designs/:slug` → `{ slug }`). Values are decoded strings. */
export type RouteParams<K extends RouteKey> = { [Name in ParamNames<RoutePattern<K>>]: string };
export type RouteQuery<K extends RouteKey> = ApiRoutes[K]['query'];
export type RouteBody<K extends RouteKey> = ApiRoutes[K]['body'];
export type RouteResponse<K extends RouteKey> = ApiRoutes[K]['response'];

/** Lane that implements each route. Exhaustive by type: adding a route without an owner fails typecheck. */
export const ROUTE_OWNERS = {
  'GET /health': 'WP0',
  'GET /settings': 'WP1',
  'PUT /settings': 'WP1',
  'GET /changes': 'WP1',
  'GET /designs': 'WP1',
  'POST /designs': 'WP1',
  'GET /designs/:slug': 'WP1',
  'PATCH /designs/:slug': 'WP1',
  'DELETE /designs/:slug': 'WP1',
  'POST /designs/:slug/comments': 'WP1',
  'PATCH /designs/:slug/comments/:id': 'WP1',
  'DELETE /designs/:slug/comments/:id': 'WP1',
  'POST /designs/:slug/comments/mark-sent': 'WP1',
  'POST /uploads': 'WP1',
  'PUT /uploads/:id/:index': 'WP1',
  'GET /outbox': 'WP1',
  'PUT /outbox': 'WP1',
  'DELETE /outbox': 'WP1',
  'GET /designs/:slug/render': 'WP2',
  'GET /designs/:slug/render/chunk': 'WP2',
  'GET /designs/:slug/source': 'WP2',
  'GET /designs/:slug/thumbnail': 'WP2',
  'POST /designs/:slug/thumbnail/refresh': 'WP2',
  'GET /designs/:slug/versions': 'WP2',
  'POST /designs/:slug/versions': 'WP2',
  'POST /versions/turn': 'WP2',
  'GET /designs/:slug/versions/:vid/diff': 'WP2',
  'POST /designs/:slug/versions/:vid/restore': 'WP2',
  'POST /designs/:slug/export': 'WP2',
  'POST /reveal': 'WP2',
  'GET /presets': 'WP3',
  'POST /chip': 'WP3',
  'POST /designs/:slug/prompt': 'WP3',
  'POST /artifacts/from-message': 'WP3',
  'DELETE /open-request': 'WP3',
} as const satisfies Record<RouteKey, 'WP0' | 'WP1' | 'WP2' | 'WP3'>;

export const ROUTE_KEYS = Object.keys(ROUTE_OWNERS) as RouteKey[];

/** Routes whose 200 answer is raw text, not JSON. */
export const RAW_TEXT_ROUTES: ReadonlySet<RouteKey> = new Set<RouteKey>(['GET /designs/:slug/render/chunk']);

export const splitRouteKey = <K extends RouteKey>(key: K): { method: RouteMethod<K>; pattern: RoutePattern<K> } => {
  const space = key.indexOf(' ');
  // Safe: every RouteKey is "<METHOD> <pattern>" by the template types above.
  return { method: key.slice(0, space) as RouteMethod<K>, pattern: key.slice(space + 1) as RoutePattern<K> };
};

/** Concrete request path for a route: each `:param` replaced by its percent-encoded value. */
export const routePath = <K extends RouteKey>(key: K, params: RouteParams<K>): string => {
  const values: Readonly<Record<string, string>> = params;
  return splitRouteKey(key).pattern.replace(/:([A-Za-z]+)/g, (_match, name: string) => {
    const value = values[name];
    if (value === undefined || value === '') throw new Error(`Missing path parameter "${name}" for ${key}.`);
    return encodeURIComponent(value);
  });
};
