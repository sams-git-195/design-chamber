// Typed access to the local service through the host's `serviceRequest` (docs/SPEC.md §7, §8.2).
//
// - `call(route, …)`: JSON in/out, every failure becomes a `ServiceError { code, message }`
//   whose message is a sentence the UI can show as is.
// - `loadRender`: render meta + raw chunks (F8 caps one answer at 8 MB), 3 in parallel,
//   one retry when the service evicted the key (`stale`); documents cached by render key.
// - `upload`: large text in chunks that respect F7 (≤ 60 000 chars after JSON.stringify,
//   ≤ 75 000 UTF-8 bytes per request body), never splitting a surrogate pair.
// - `thumbnail`: PNG answers cached by thumbnail key.

import { HostRequestError, type GuestRequest, type GuestRequestResult, type HostRequestErrorCode } from '@openchamber/sdk';

import {
  RAW_TEXT_ROUTES,
  isApiErrorCode,
  routePath,
  splitRouteKey,
  type ApiErrorCode,
  type RenderMeta,
  type RouteBody,
  type RouteKey,
  type RouteParams,
  type RouteQuery,
  type RouteResponse,
  type ThumbnailResponse,
} from '../shared/api.ts';
import {
  GUEST_RENDER_CACHE_MAX_BYTES,
  RENDER_CHUNK_CONCURRENCY,
  UPLOAD_CHUNK_MAX_BYTES,
  UPLOAD_CHUNK_MAX_CHARS,
  UPLOAD_TOTAL_MAX,
} from '../shared/limits.ts';

// ---- Errors ----

export type ServiceErrorCode = ApiErrorCode | HostRequestErrorCode | 'bad-response';

export class ServiceError extends Error {
  readonly code: ServiceErrorCode;
  /** HTTP status from the service; null when the request never got an answer. */
  readonly status: number | null;

  constructor(code: ServiceErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
  }
}

export const isServiceError = (error: unknown, code?: ServiceErrorCode): error is ServiceError =>
  error instanceof ServiceError && (code === undefined || error.code === code);

const HOST_MESSAGES: Partial<Record<HostRequestErrorCode, string>> = {
  NO_SERVICE: 'The Design Chamber service is not running. Allow the local service in Settings → Extensions, then try again.',
  SERVICE_FAILED: 'The Design Chamber service stopped unexpectedly. Try again; if it keeps failing, re-enable the extension.',
  HOST_TIMEOUT: 'The Design Chamber service took too long to answer. Try again.',
  REQUEST_FAILED: 'The Design Chamber service did not answer. Try again.',
  RESPONSE_TOO_LARGE: 'The answer from the Design Chamber service was too large to load.',
  DISABLED: 'Design Chamber is paused. Turn it back on in Settings → Extensions.',
  HOST_UNAVAILABLE: 'OpenChamber is not reachable from this view. Reopen the panel.',
};

/** Any thrown value from `serviceRequest` → ServiceError with a user-facing message. */
export const toServiceError = (error: unknown): ServiceError => {
  if (error instanceof ServiceError) return error;
  if (error instanceof HostRequestError) return new ServiceError(error.code, HOST_MESSAGES[error.code] ?? error.message);
  return new ServiceError('REQUEST_FAILED', error instanceof Error && error.message ? error.message : 'The Design Chamber service did not answer. Try again.');
};

const errorFromAnswer = (answer: GuestRequestResult): ServiceError => {
  try {
    const body: unknown = JSON.parse(answer.body);
    if (typeof body === 'object' && body !== null && 'error' in body && 'message' in body) {
      const { error, message } = body;
      if (isApiErrorCode(error) && typeof message === 'string' && message !== '') return new ServiceError(error, message, answer.status);
    }
  } catch {
    // Not JSON: fall through to the generic sentence below.
  }
  return new ServiceError(answer.status === 401 ? 'unauthorized' : 'internal', `The Design Chamber service answered with an error (${answer.status}). Try again.`, answer.status);
};

// ---- Typed call ----

type HasParams<K extends RouteKey> = keyof RouteParams<K> extends never ? false : true;
type HasBody<K extends RouteKey> = RouteBody<K> extends undefined ? false : true;

export type CallRequest<K extends RouteKey> = (HasParams<K> extends true ? { params: RouteParams<K> } : { params?: undefined }) &
  (HasBody<K> extends true ? { body: RouteBody<K> } : { body?: undefined }) & { query?: RouteQuery<K> };

/** `call(key)` when the route needs nothing, `call(key, { params, body, query })` otherwise. */
export type CallArgs<K extends RouteKey> = HasParams<K> extends true
  ? [request: CallRequest<K>]
  : HasBody<K> extends true
    ? [request: CallRequest<K>]
    : [request?: CallRequest<K>];

/** The part of the SDK `HostClient` the service client needs. */
export type ServiceTransport = { serviceRequest(request: GuestRequest): Promise<GuestRequestResult> };

export type RenderDoc = { meta: RenderMeta; html: string };

export type ServiceClient = {
  call<K extends RouteKey>(key: K, ...args: CallArgs<K>): Promise<RouteResponse<K>>;
  /** Full bundled document for an artifact (`screen` null) or a canvas screen, optionally at a version. */
  loadRender(slug: string, screen?: string | null, version?: string | null): Promise<RenderDoc>;
  /** Uploads `text` in F7-safe chunks; resolves to the completed upload id. */
  upload(text: string): Promise<string>;
  /** Thumbnail state; a `ready` PNG is served from memory when `key` matches a cached one. */
  thumbnail(slug: string, key?: string | null): Promise<ThumbnailResponse>;
};

const queryOf = (query: Record<string, string | undefined> | undefined): Record<string, string> | undefined => {
  if (!query) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(query)) if (value !== undefined) out[name] = value;
  return Object.keys(out).length > 0 ? out : undefined;
};

// ---- Upload chunking (pure, exported for tests) ----

/** UTF-8 byte length of a string (no TextEncoder needed). */
export const utf8Length = (text: string): number => {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
};

/** `{"data":""}`: the request body around one chunk. */
const BODY_OVERHEAD = '{"data":""}'.length;

/** Cost of one code point once JSON-escaped: [chars, UTF-8 bytes]. */
const escapedCost = (codePoint: string): [number, number] => {
  const code = codePoint.charCodeAt(0);
  if (codePoint.length === 1 && code >= 0x20 && code < 0x7f && code !== 0x22 && code !== 0x5c) return [1, 1];
  const escaped = JSON.stringify(codePoint).slice(1, -1);
  return [escaped.length, utf8Length(escaped)];
};

/**
 * Splits text so every chunk, as `JSON.stringify(chunk)`, is ≤ `maxChars` and the request body
 * `{"data":…}` is ≤ `maxBytes` UTF-8 bytes. Splits only between code points.
 */
export const splitUploadChunks = (text: string, maxChars: number = UPLOAD_CHUNK_MAX_CHARS, maxBytes: number = UPLOAD_CHUNK_MAX_BYTES): string[] => {
  const chunks: string[] = [];
  let start = 0;
  let chars = 2; // the quotes JSON.stringify adds
  let bytes = BODY_OVERHEAD;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const width = code >= 0xd800 && code <= 0xdbff && index + 1 < text.length && (text.charCodeAt(index + 1) & 0xfc00) === 0xdc00 ? 2 : 1;
    const [costChars, costBytes] = escapedCost(text.slice(index, index + width));
    if (index > start && (chars + costChars > maxChars || bytes + costBytes > maxBytes)) {
      chunks.push(text.slice(start, index));
      start = index;
      chars = 2;
      bytes = BODY_OVERHEAD;
    }
    chars += costChars;
    bytes += costBytes;
    index += width;
  }
  if (index > start) chunks.push(text.slice(start));
  return chunks;
};

// ---- Concurrency helper ----

const mapLimit = async <T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // Safe: index < items.length was checked on the line above the increment.
      out[index] = await run(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

// ---- Client ----

export type ServiceClientOptions = { renderCacheBytes?: number };

/** Ready thumbnails kept in memory (each ~10–40 kB of base64). */
const THUMB_CACHE_MAX = 200;

export const createServiceClient = (transport: ServiceTransport, options: ServiceClientOptions = {}): ServiceClient => {
  const renderCacheMax = options.renderCacheBytes ?? GUEST_RENDER_CACHE_MAX_BYTES;
  /** Render key → document; Map order = LRU order (oldest first). */
  const renders = new Map<string, RenderDoc>();
  let renderBytes = 0;
  const inflight = new Map<string, Promise<RenderDoc>>();
  const thumbs = new Map<string, ThumbnailResponse>();

  const call = async <K extends RouteKey>(key: K, ...args: CallArgs<K>): Promise<RouteResponse<K>> => {
    const request: { params?: Record<string, string>; body?: unknown; query?: Record<string, string | undefined> } = args[0] ?? {};
    const { method } = splitRouteKey(key);
    // Safe: CallArgs<K> requires `params` exactly when the route has path parameters.
    const path = routePath(key, (request.params ?? {}) as RouteParams<K>);
    const guestRequest: GuestRequest = { method, path };
    const query = queryOf(request.query);
    if (query) guestRequest.query = query;
    if (request.body !== undefined) guestRequest.body = JSON.stringify(request.body);

    let answer: GuestRequestResult;
    try {
      answer = await transport.serviceRequest(guestRequest);
    } catch (error) {
      throw toServiceError(error);
    }
    if (answer.status < 200 || answer.status >= 300) throw errorFromAnswer(answer);
    // Safe: raw-text routes answer a string by contract (`RAW_TEXT_ROUTES`).
    if (RAW_TEXT_ROUTES.has(key)) return answer.body as RouteResponse<K>;
    try {
      // Safe: the service is typed from the same `ApiRoutes` table; its answers are trusted shapes.
      return JSON.parse(answer.body) as RouteResponse<K>;
    } catch {
      throw new ServiceError('bad-response', 'The Design Chamber service sent an answer that could not be read. Try again.', answer.status);
    }
  };

  const remember = (doc: RenderDoc): void => {
    if (renders.has(doc.meta.key)) return;
    renders.set(doc.meta.key, doc);
    renderBytes += doc.meta.bytes;
    for (const [key, old] of renders) {
      if (renderBytes <= renderCacheMax || renders.size <= 1) break;
      renders.delete(key);
      renderBytes -= old.meta.bytes;
    }
  };

  const fetchRender = async (slug: string, screen: string | null, version: string | null): Promise<RenderDoc> => {
    const query: RouteQuery<'GET /designs/:slug/render'> = {};
    if (screen) query.screen = screen;
    if (version) query.version = version;
    const meta = await call('GET /designs/:slug/render', { params: { slug }, query });
    const cached = renders.get(meta.key);
    if (cached) {
      renders.delete(meta.key);
      renders.set(meta.key, cached);
      return cached;
    }
    const indexes = Array.from({ length: meta.chunks }, (_, n) => n);
    const parts = await mapLimit(indexes, RENDER_CHUNK_CONCURRENCY, (n) =>
      call('GET /designs/:slug/render/chunk', { params: { slug }, query: { key: meta.key, n: String(n) } }),
    );
    const doc = { meta, html: parts.join('') };
    remember(doc);
    return doc;
  };

  const loadRender = (slug: string, screen: string | null = null, version: string | null = null): Promise<RenderDoc> => {
    const id = `${slug}\u0000${screen ?? ''}\u0000${version ?? ''}`;
    const running = inflight.get(id);
    if (running) return running;
    const task = (async () => {
      try {
        return await fetchRender(slug, screen, version);
      } catch (error) {
        // The service evicted the key between meta and chunks: build again, once.
        if (isServiceError(error, 'stale')) return fetchRender(slug, screen, version);
        throw error;
      }
    })().finally(() => inflight.delete(id));
    inflight.set(id, task);
    return task;
  };

  const upload = async (text: string): Promise<string> => {
    if (text.length > UPLOAD_TOTAL_MAX) {
      throw new ServiceError('too-large', `This text is too long to send to Design Chamber (over ${UPLOAD_TOTAL_MAX.toLocaleString('en-US')} characters).`);
    }
    const { uploadId } = await call('POST /uploads', { body: { total: text.length } });
    const chunks = splitUploadChunks(text);
    for (const [index, data] of chunks.entries()) {
      await call('PUT /uploads/:id/:index', { params: { id: uploadId, index: String(index) }, body: { data } });
    }
    return uploadId;
  };

  const thumbnail = async (slug: string, key: string | null = null): Promise<ThumbnailResponse> => {
    if (key) {
      const cached = thumbs.get(key);
      if (cached) return cached;
    }
    const answer = await call('GET /designs/:slug/thumbnail', { params: { slug } });
    if (answer.state === 'ready' && answer.key && answer.png) {
      thumbs.set(answer.key, answer);
      const oldest = thumbs.keys().next();
      if (thumbs.size > THUMB_CACHE_MAX && !oldest.done) thumbs.delete(oldest.value);
    }
    return answer;
  };

  return { call, loadRender, upload, thumbnail };
};
