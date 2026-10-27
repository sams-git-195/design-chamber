// HTTP layer of the local service (docs/SPEC.md §7, §9.7): bearer check, a tiny typed
// router over `ApiRoutes`, JSON body parsing with a size cap, error mapping, and /health.
//
// The host proxy is the only caller (GUEST_SERVICES.md): it binds us to 127.0.0.1, sends
// `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN` on every request, and polls GET /health
// until 200. Every request — /health and unknown paths included — is refused with 401 unless
// the token matches. The token is never logged or echoed.

import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

import {
  API_ERROR_STATUS,
  RAW_TEXT_ROUTES,
  splitRouteKey,
  type ApiErrorBody,
  type ApiErrorCode,
  type HealthResponse,
  type HttpMethod,
  type RouteKey,
  type RouteParams,
  type RouteResponse,
} from '../shared/api.ts';
import { SERVICE_REQUEST_BODY_MAX_BYTES, SERVICE_RESPONSE_MAX_BYTES } from '../shared/limits.ts';
import type { Logger } from './context.ts';

/** A failure with a user-facing message. Throw it from any handler or module; the router answers `{ error, message }`. */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
  }
}

const INTERNAL_MESSAGE = 'Design Chamber’s local service hit an unexpected problem. Try again; if it keeps happening, turn the extension off and on in Settings → Extensions.';

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time check of an `Authorization` header against the service token. An empty token never matches. */
export const bearerMatches = (header: string | undefined, token: string): boolean =>
  token.length > 0 && timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`));

export type RouteRequest<K extends RouteKey> = {
  key: K;
  /** Decoded path params. Never contain `/`, `\` or NUL; still validate them (slug regex + containment). */
  params: RouteParams<K>;
  query: URLSearchParams;
  /** Parsed JSON body, `undefined` when empty. Untrusted: validate before use. */
  body: unknown;
  /** Aborted when the caller goes away (long-polls stop waiting). */
  signal: AbortSignal;
};

export type RouteHandler<K extends RouteKey> = (request: RouteRequest<K>) => RouteResponse<K> | Promise<RouteResponse<K>>;

export type Router = {
  /** Register the handler of one `ApiRoutes` key. Registering a key twice throws. */
  on<K extends RouteKey>(key: K, handler: RouteHandler<K>): void;
  /** Keys registered so far (integration checks every `ROUTE_KEYS` entry is served). */
  registered(): RouteKey[];
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
};

type Segment = { literal: string } | { param: string };
type Entry = {
  key: RouteKey;
  method: HttpMethod;
  segments: Segment[];
  literals: number;
  // Safe: each entry stores the handler registered under its own key; `on` enforces the pairing.
  handler: RouteHandler<RouteKey>;
};

const compile = (pattern: string): Segment[] =>
  pattern.split('/').slice(1).map((part) => (part.startsWith(':') ? { param: part.slice(1) } : { literal: part }));

const sendJson = (res: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
};

const sendError = (res: http.ServerResponse, code: ApiErrorCode, message: string): void => {
  const body: ApiErrorBody = { error: code, message };
  sendJson(res, API_ERROR_STATUS[code], body);
};

class BodyTooLarge extends Error {}

const readBody = (req: http.IncomingMessage, maxBytes: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > maxBytes) {
        done = true;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (error) => {
      if (!done) reject(error);
      done = true;
    });
  });

export type RouterOptions = {
  token: string;
  log: Logger;
  /** Request body cap in bytes (default `SERVICE_REQUEST_BODY_MAX_BYTES`). */
  maxBodyBytes?: number;
  /** Response cap in bytes (default `SERVICE_RESPONSE_MAX_BYTES`). */
  maxResponseBytes?: number;
};

export const createRouter = (options: RouterOptions): Router => {
  const { token, log } = options;
  const maxBodyBytes = options.maxBodyBytes ?? SERVICE_REQUEST_BODY_MAX_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? SERVICE_RESPONSE_MAX_BYTES;
  const entries: Entry[] = [];

  const match = (method: string, parts: string[]): { entry: Entry; values: string[] } | null => {
    let best: { entry: Entry; values: string[] } | null = null;
    for (const entry of entries) {
      if (entry.method !== method || entry.segments.length !== parts.length) continue;
      const values: string[] = [];
      const ok = entry.segments.every((segment, index) => {
        const part = parts[index] ?? '';
        if ('literal' in segment) return segment.literal === part;
        values.push(part);
        return part.length > 0;
      });
      if (ok && (!best || entry.literals > best.entry.literals)) best = { entry, values };
    }
    return best;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = req.method ?? 'GET';
    if (!bearerMatches(req.headers.authorization, token)) {
      req.resume();
      sendError(res, 'unauthorized', 'This request did not carry the service token.');
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      req.resume();
      sendError(res, 'bad-request', 'The request address is not valid.');
      return;
    }

    const rawParts = url.pathname.split('/').slice(1);
    const found = match(method, rawParts);
    if (!found) {
      req.resume();
      sendError(res, 'not-found', 'Design Chamber’s service has no such route.');
      return;
    }

    const { entry } = found;
    const params: Record<string, string> = {};
    let paramIndex = 0;
    for (const segment of entry.segments) {
      if (!('param' in segment)) continue;
      const raw = found.values[paramIndex] ?? '';
      paramIndex += 1;
      let value: string;
      try {
        value = decodeURIComponent(raw);
      } catch {
        req.resume();
        sendError(res, 'bad-request', 'The request address is not valid.');
        return;
      }
      if (/[/\\\0]/.test(value)) {
        req.resume();
        sendError(res, 'bad-path', 'That name contains characters a design path cannot have.');
        return;
      }
      params[segment.param] = value;
    }

    let body: unknown;
    try {
      const text = await readBody(req, maxBodyBytes);
      body = text.length === 0 ? undefined : JSON.parse(text);
    } catch (error) {
      if (error instanceof BodyTooLarge) {
        sendError(res, 'too-large', 'This request is larger than the service accepts.');
        req.resume();
      } else if (error instanceof SyntaxError) {
        sendError(res, 'bad-request', 'The request body is not valid JSON.');
      } else {
        log.warn('request.read-failed', { route: entry.key, error: error instanceof Error ? error.message : String(error) });
        sendError(res, 'bad-request', 'The request could not be read.');
      }
      return;
    }

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    try {
      const result = await entry.handler({
        key: entry.key,
        // Safe: `params` holds exactly the `:name` segments of this entry's pattern.
        params: params as RouteParams<RouteKey>,
        query: url.searchParams,
        body,
        signal: controller.signal,
      });
      if (res.writableEnded || controller.signal.aborted) return;
      const raw = RAW_TEXT_ROUTES.has(entry.key);
      const text = raw ? String(result) : JSON.stringify(result);
      const bytes = Buffer.byteLength(text);
      if (bytes > maxResponseBytes) {
        log.error('response.too-large', { route: entry.key, bytes });
        sendError(res, 'too-large', 'The answer is too large to send to OpenChamber.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': raw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': bytes,
      });
      res.end(text);
    } catch (error) {
      if (res.headersSent) return;
      if (error instanceof ApiError) {
        sendError(res, error.code, error.message);
        return;
      }
      log.error('route.failed', { route: entry.key, error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
      sendError(res, 'internal', INTERNAL_MESSAGE);
    }
  };

  return {
    on(key, handler) {
      if (entries.some((entry) => entry.key === key)) throw new Error(`Route ${key} is registered twice.`);
      const { method, pattern } = splitRouteKey(key);
      const segments = compile(pattern);
      entries.push({
        key,
        method,
        segments,
        literals: segments.filter((segment) => 'literal' in segment).length,
        // Safe: this handler is only ever called for requests matched to `key`.
        handler: handler as unknown as RouteHandler<RouteKey>,
      });
    },
    registered: () => entries.map((entry) => entry.key),
    handle: async (req, res) => {
      try {
        await handle(req, res);
      } catch (error) {
        log.error('request.failed', { error: error instanceof Error ? (error.stack ?? error.message) : String(error) });
        if (!res.headersSent) sendError(res, 'internal', INTERNAL_MESSAGE);
        else res.destroy();
      }
    },
  };
};

/** GET /health: the host's ready probe (bearer required like every route). */
export const registerHealthRoute = (router: Router, info: { version: string; epoch: string }): void => {
  router.on('GET /health', (): HealthResponse => ({ ok: true, version: info.version, epoch: info.epoch }));
};

export const createServiceServer = (router: Router): http.Server =>
  http.createServer((req, res) => {
    void router.handle(req, res);
  });

/** Listen on loopback only. Resolves with the bound port. */
export const listenLoopback = (server: http.Server, port: number): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
