import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, test, type TestContext } from 'node:test';

import { ApiError, bearerMatches, createRouter, createServiceServer, listenLoopback, type Router } from '../../../src/service/http.ts';
import type { Logger } from '../../../src/service/context.ts';

const TOKEN = 'test-token-0123456789';

type Logged = { level: string; event: string; fields?: unknown };

const serve = async (t: TestContext, setup: (router: Router) => void, limits: { maxBodyBytes?: number; maxResponseBytes?: number } = {}) => {
  const logs: Logged[] = [];
  const log: Logger = {
    info: (event, fields) => void logs.push({ level: 'info', event, fields }),
    warn: (event, fields) => void logs.push({ level: 'warn', event, fields }),
    error: (event, fields) => void logs.push({ level: 'error', event, fields }),
  };
  const router = createRouter({ token: TOKEN, log, ...limits });
  setup(router);
  const server = createServiceServer(router);
  await listenLoopback(server, 0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port, address } = server.address() as AddressInfo;
  assert.equal(address, '127.0.0.1');
  const call = (path: string, init: { method?: string; body?: string; token?: string | null } = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: init.method ?? 'GET',
      headers: init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` },
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
  return { call, logs };
};

// Test handlers echo what the router passed in; the cast only bypasses the real response types.
const echo = <T>(value: unknown): T => value as T;

describe('bearer auth', () => {
  test('bearerMatches is exact and never matches an empty token', () => {
    assert.equal(bearerMatches(`Bearer ${TOKEN}`, TOKEN), true);
    assert.equal(bearerMatches(`Bearer ${TOKEN} `, TOKEN), false);
    assert.equal(bearerMatches(`bearer ${TOKEN}`, TOKEN), false);
    assert.equal(bearerMatches(TOKEN, TOKEN), false);
    assert.equal(bearerMatches(undefined, TOKEN), false);
    assert.equal(bearerMatches('Bearer ', ''), false);
  });

  test('every request without the right token is 401, registered or not', async (t) => {
    const { call } = await serve(t, (router) => router.on('GET /designs', () => echo({ root: '', designs: [] })));
    for (const [path, token] of [['/designs', null], ['/designs', 'wrong'], ['/nope', null], ['/health', 'x']] as const) {
      const answer = await call(path, { token });
      assert.equal(answer.status, 401, `${path} ${token}`);
      assert.deepEqual(await answer.json(), { error: 'unauthorized', message: 'This request did not carry the service token.' });
    }
    assert.equal((await call('/designs')).status, 200);
  });
});

describe('routing', () => {
  test('unknown routes and wrong methods are 404', async (t) => {
    const { call } = await serve(t, (router) => router.on('GET /designs', () => echo({ root: '', designs: [] })));
    assert.equal((await call('/missing')).status, 404);
    assert.equal((await call('/designs', { method: 'DELETE' })).status, 404);
    assert.equal((await call('/designs/')).status, 404);
  });

  test('path params are decoded; encoded separators and NUL are refused', async (t) => {
    const { call } = await serve(t, (router) => {
      router.on('GET /designs/:slug', ({ params }) => echo({ slug: params.slug }));
      router.on('PATCH /designs/:slug/comments/:id', ({ params, body }) => echo({ params, body }));
    });
    assert.deepEqual(await (await call('/designs/hello%20world')).json(), { slug: 'hello world' });
    for (const bad of ['..%2Fsecret', '..%5Csecret', 'a%00b', '%2e%2e%2f']) {
      const answer = await call(`/designs/${bad}`);
      assert.equal(answer.status, 400, bad);
      assert.equal(((await answer.json()) as { error: string }).error, 'bad-path');
    }
    const malformed = await call('/designs/%E0%A4%A');
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as { error: string }).error, 'bad-request');
    const both = await call('/designs/a/comments/c_1', { method: 'PATCH', body: '{"status":"resolved"}' });
    assert.deepEqual(await both.json(), { params: { slug: 'a', id: 'c_1' }, body: { status: 'resolved' } });
  });

  test('dot segments are normalised before matching, never reach a handler as a param', async (t) => {
    const seen: string[] = [];
    const { call } = await serve(t, (router) => {
      router.on('GET /designs/:slug', ({ params }) => {
        seen.push(params.slug);
        return echo({});
      });
      router.on('GET /settings', () => echo({ settings: true }));
    });
    assert.deepEqual(await (await call('/designs/../settings')).json(), { settings: true });
    assert.deepEqual(seen, []);
  });

  test('registering a route twice throws', () => {
    const router = createRouter({ token: TOKEN, log: { info() {}, warn() {}, error() {} } });
    router.on('GET /presets', () => echo({ presets: [] }));
    assert.throws(() => router.on('GET /presets', () => echo({ presets: [] })), /registered twice/);
    assert.deepEqual(router.registered(), ['GET /presets']);
  });
});

describe('bodies and answers', () => {
  test('invalid JSON is 400, an empty body is undefined', async (t) => {
    const { call } = await serve(t, (router) => router.on('PUT /settings', ({ body }) => echo({ body: body === undefined ? 'none' : body })));
    const bad = await call('/settings', { method: 'PUT', body: '{nope' });
    assert.equal(bad.status, 400);
    assert.equal(((await bad.json()) as { error: string }).error, 'bad-request');
    assert.deepEqual(await (await call('/settings', { method: 'PUT' })).json(), { body: 'none' });
  });

  test('a body over the cap is 413 and the handler never runs', async (t) => {
    let ran = false;
    const { call } = await serve(
      t,
      (router) =>
        router.on('PUT /settings', () => {
          ran = true;
          return echo({});
        }),
      { maxBodyBytes: 100 },
    );
    const answer = await call('/settings', { method: 'PUT', body: JSON.stringify({ root: 'x'.repeat(200) }) });
    assert.equal(answer.status, 413);
    assert.equal(((await answer.json()) as { error: string }).error, 'too-large');
    assert.equal(ran, false);
  });

  test('ApiError maps to its status and sentence; other errors are 500 without internals', async (t) => {
    const { call, logs } = await serve(t, (router) => {
      router.on('GET /designs/:slug', () => {
        throw new ApiError('not-found', 'That design does not exist.');
      });
      router.on('GET /presets', () => {
        throw new Error('secret internal detail C:\\Users\\x');
      });
    });
    const notFound = await call('/designs/x');
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: 'not-found', message: 'That design does not exist.' });
    const crash = await call('/presets');
    assert.equal(crash.status, 500);
    const body = (await crash.json()) as { error: string; message: string };
    assert.equal(body.error, 'internal');
    assert.doesNotMatch(body.message, /secret/);
    assert.ok(logs.some((line) => line.level === 'error' && line.event === 'route.failed'));
  });

  test('raw text routes answer text/plain; JSON routes answer JSON', async (t) => {
    const { call } = await serve(t, (router) => {
      router.on('GET /designs/:slug/render/chunk', ({ query }) => `<p>chunk ${query.get('n')}</p>`);
      router.on('GET /presets', () => ({ presets: [] }));
    });
    const raw = await call('/designs/x/render/chunk?key=k&n=2');
    assert.match(raw.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(await raw.text(), '<p>chunk 2</p>');
    const json = await call('/presets');
    assert.match(json.headers.get('content-type') ?? '', /^application\/json/);
    assert.deepEqual(await json.json(), { presets: [] });
  });

  test('an answer over the response cap is refused with 413, not cut off', async (t) => {
    const { call } = await serve(t, (router) => router.on('GET /presets', () => echo({ presets: ['x'.repeat(500)] })), { maxResponseBytes: 100 });
    const answer = await call('/presets');
    assert.equal(answer.status, 413);
  });
});
