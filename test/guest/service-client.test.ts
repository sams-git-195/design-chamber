import assert from 'node:assert/strict';
import { test } from 'node:test';

import { HostRequestError, type GuestRequest, type GuestRequestResult } from '@openchamber/sdk';

import { createFakeService } from '../../src/guest/fake-services.ts';
import { createServiceClient, ServiceError, splitUploadChunks, utf8Length, type ServiceTransport } from '../../src/guest/service-client.ts';
import { HOST_REQUEST_BODY_MAX_CHARS, SERVICE_REQUEST_BODY_MAX_BYTES, UPLOAD_CHUNK_MAX_BYTES, UPLOAD_CHUNK_MAX_CHARS } from '../../src/shared/limits.ts';

const json = (status: number, body: unknown): GuestRequestResult => ({ status, body: JSON.stringify(body) });

const recording = (answer: (request: GuestRequest) => GuestRequestResult | Promise<GuestRequestResult>) => {
  const requests: GuestRequest[] = [];
  const transport: ServiceTransport = {
    serviceRequest: async (request) => {
      requests.push(request);
      return answer(request);
    },
  };
  return { requests, client: createServiceClient(transport) };
};

const rejects = async (promise: Promise<unknown>, code: string, message?: RegExp, status?: number | null): Promise<void> => {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ServiceError, `ServiceError expected, got ${String(error)}`);
    assert.equal(error.code, code);
    if (message) assert.match(error.message, message);
    if (status !== undefined) assert.equal(error.status, status);
    return true;
  });
};

test('call: method, encoded path params, query without undefined, JSON body', async () => {
  const { requests, client } = recording(() => json(200, { comment: { id: 'c_1' } }));
  await client.call('PATCH /designs/:slug/comments/:id', { params: { slug: 'a b', id: 'c_1/x' }, body: { status: 'resolved' } });
  await client.call('GET /designs', { query: { q: 'coffee', kind: undefined } });
  await client.call('GET /health');
  assert.deepEqual(requests[0], { method: 'PATCH', path: '/designs/a%20b/comments/c_1%2Fx', body: '{"status":"resolved"}' });
  assert.deepEqual(requests[1], { method: 'GET', path: '/designs', query: { q: 'coffee' } });
  assert.deepEqual(requests[2], { method: 'GET', path: '/health' });
});

test('call: service errors keep code, message and status; garbage becomes a sentence', async () => {
  const answers: GuestRequestResult[] = [
    json(404, { error: 'not-found', message: 'That design no longer exists.' }),
    { status: 502, body: '<html>bad gateway</html>' },
    json(401, { nope: true }),
    { status: 200, body: 'not json' },
  ];
  const { client } = recording(() => answers.shift() ?? json(500, {}));
  await rejects(client.call('GET /designs/:slug', { params: { slug: 'x' } }), 'not-found', /^That design no longer exists\.$/, 404);
  await rejects(client.call('GET /designs'), 'internal', /answered with an error \(502\)/, 502);
  await rejects(client.call('GET /designs'), 'unauthorized', /\(401\)/, 401);
  await rejects(client.call('GET /designs'), 'bad-response', /could not be read/, 200);
});

test('call: host failures map to user-facing sentences', async () => {
  const thrown = [new HostRequestError('NO_SERVICE', 'raw'), new HostRequestError('HOST_TIMEOUT', 'raw'), new Error('boom')];
  const { client } = recording(() => {
    throw thrown.shift();
  });
  await rejects(client.call('GET /health'), 'NO_SERVICE', /Allow the local service in Settings → Extensions/, null);
  await rejects(client.call('GET /health'), 'HOST_TIMEOUT', /took too long/);
  await rejects(client.call('GET /health'), 'REQUEST_FAILED', /boom/);
});

test('loadRender: reassembles a multi-chunk multi-byte document byte-exact, ≤ 3 chunk fetches in flight', async () => {
  const service = createFakeService({ renderChunkChars: 7 });
  const html = `<!doctype html><title>Ünïcödé 🎨</title><body>${'Ω≈ç√∫ 漢字 😀 '.repeat(40)}</body>`;
  service.writeFile('launch-announcement', 'index.html', html);
  let inFlight = 0;
  let peak = 0;
  const transport: ServiceTransport = {
    serviceRequest: async (request) => {
      const chunk = request.path.endsWith('/render/chunk');
      if (chunk) inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, chunk ? 1 : 0));
      const answer = await service.handle(request);
      if (chunk) inFlight -= 1;
      return answer;
    },
  };
  const client = createServiceClient(transport);
  const doc = await client.loadRender('launch-announcement');
  assert.equal(doc.html, html);
  assert.ok(doc.meta.chunks > 10);
  assert.equal(peak, 3);

  // Cached by render key: the second load asks for meta only.
  const before = service.requests.length;
  const again = await client.loadRender('launch-announcement');
  assert.equal(again.html, html);
  assert.deepEqual(service.requests.slice(before).map((r) => r.path), ['/designs/launch-announcement/render']);
});

test('loadRender: retries once when the key went stale; concurrent loads share one fetch', async () => {
  let metas = 0;
  let staleOnce = true;
  const { requests, client } = recording((request) => {
    if (request.path.endsWith('/render')) {
      metas += 1;
      return json(200, { key: `k${metas}`, chunks: 2, bytes: 6, title: '', missing: [], blocked: [], external: [], warnings: [] });
    }
    if (staleOnce) {
      staleOnce = false;
      return json(409, { error: 'stale', message: 'Changed.' });
    }
    return { status: 200, body: request.query?.n === '0' ? 'abc' : 'def' };
  });
  const [one, two] = await Promise.all([client.loadRender('d', 'home'), client.loadRender('d', 'home')]);
  assert.equal(one.html, 'abcdef');
  assert.equal(one, two);
  assert.equal(metas, 2, 'meta fetched again after stale');
  assert.deepEqual(requests[0]?.query, { screen: 'home' });

  const { client: failing } = recording((request) =>
    request.path.endsWith('/render') ? json(200, { key: 'k', chunks: 1, bytes: 1, title: '', missing: [], blocked: [], external: [], warnings: [] }) : json(409, { error: 'stale', message: 'Changed again.' }),
  );
  await rejects(failing.loadRender('d'), 'stale', /Changed again/);
});

test('splitUploadChunks: every chunk within F7 limits for multi-byte text, pairs never split', () => {
  const samples = [
    'a'.repeat(200_000),
    '漢字かな交じり文'.repeat(20_000),
    '😀🎨👩‍💻'.repeat(30_000),
    '"\\\n\t\u0001</script>'.repeat(20_000),
    `${'x'.repeat(59_997)}😀😀😀`,
    '\ud800 lone \udc00 surrogates '.repeat(5_000),
  ];
  for (const text of samples) {
    const chunks = splitUploadChunks(text);
    assert.equal(chunks.join(''), text, 'reassembles exactly');
    let offset = 0;
    for (const chunk of chunks) {
      offset += chunk.length;
      const data = JSON.stringify(chunk);
      const body = JSON.stringify({ data: chunk });
      assert.ok(data.length <= UPLOAD_CHUNK_MAX_CHARS, `data ${data.length} chars`);
      assert.ok(utf8Length(body) <= UPLOAD_CHUNK_MAX_BYTES, `body ${utf8Length(body)} bytes`);
      assert.ok(body.length <= HOST_REQUEST_BODY_MAX_CHARS);
      assert.ok(Buffer.byteLength(body) <= SERVICE_REQUEST_BODY_MAX_BYTES);
      const last = chunk.charCodeAt(chunk.length - 1);
      const next = text.charCodeAt(offset);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff), 'surrogate pair split');
    }
  }
  // 4-byte emoji fill the byte budget before the char budget.
  const emoji = splitUploadChunks('😀'.repeat(40_000));
  assert.ok(emoji.length >= 3, `${emoji.length} chunks`);
  assert.deepEqual(splitUploadChunks(''), []);
  assert.equal(utf8Length('aé漢😀'), 1 + 2 + 3 + 4);
});

test('upload: creates the upload with total = UTF-16 length and PUTs chunks in order', async () => {
  const service = createFakeService();
  const client = createServiceClient({ serviceRequest: (request) => service.handle(request) });
  const text = `${'é'.repeat(70_000)}😀${'z'.repeat(10)}`;
  const uploadId = await client.upload(text);
  const puts = service.requests.filter((request) => request.method === 'PUT');
  assert.ok(puts.length >= 2);
  assert.deepEqual(
    puts.map((request) => request.path),
    puts.map((_r, index) => `/uploads/${uploadId}/${index}`),
  );
  const create = service.requests.find((request) => request.path === '/uploads');
  assert.deepEqual(JSON.parse(create?.body ?? '{}'), { total: text.length });
  await rejects(client.upload('x'.repeat(2_000_001)), 'too-large', /too long/);
});

test('thumbnail: a ready PNG is cached by key', async () => {
  let calls = 0;
  const { client } = recording(() => {
    calls += 1;
    return json(200, { state: 'ready', key: 'k1', png: 'iVBOR', width: 320, height: 200 });
  });
  const first = await client.thumbnail('d', 'k1');
  const second = await client.thumbnail('d', 'k1');
  assert.equal(first, second);
  assert.equal(calls, 1);
  await client.thumbnail('d', 'k2');
  assert.equal(calls, 2);
});
