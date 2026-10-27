// The WP1 HTTP surface end to end (docs/SPEC.md §7, §15.2): the real router with the real
// WP1 modules behind it, called over loopback with a bearer exactly like the host proxy —
// settings + previousRoots counts, designs CRUD, comments, the /changes long-poll, chunked
// uploads reassembling 200 000 multi-byte chars into an artifact, the outbox slot, and the
// auth/validation refusals.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import type {
  ChangesResponse,
  CommentResponse,
  CreateDesignResponse,
  CreateUploadResponse,
  DeleteDesignResponse,
  DesignDetailResponse,
  DesignListResponse,
  MarkSentResponse,
  OkResponse,
  OutboxResponse,
  PatchDesignResponse,
  PutUploadChunkResponse,
  SettingsResponse,
} from '../../../src/shared/api.ts';
import { ROUTE_KEYS, ROUTE_OWNERS } from '../../../src/shared/api.ts';
import { resolveBrowser } from '../../../src/service/chrome.ts';
import { REPO_ROOT, useServedCore } from './harness.ts';

const json = async <T>(answer: Response): Promise<T> => {
  assert.equal(answer.headers.get('content-type'), 'application/json; charset=utf-8');
  return (await answer.json()) as T;
};

const errorOf = async (answer: Response): Promise<{ error: string; message: string }> => json(answer);

const anchor = { selector: 'main > h1', text: 'Ship faster', html: '<h1 class="hero">', rect: { x: 120, y: 340, w: 600, h: 64 }, point: { x: 0.12, y: 0.5 } };

/** Code-point-safe chunker respecting the F7 caps like the guest chunker (SPEC §8.2). */
const chunkText = (text: string, maxChars = 50_000, maxBytes = 65_000): string[] => {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of text) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (current.length > 0 && (current.length + char.length > maxChars || currentBytes + charBytes > maxBytes)) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += charBytes;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

describe('route registration and auth', () => {
  test('every WP1 route is registered on the router', async (t) => {
    const core = await useServedCore(t);
    const registered = new Set(core.router.registered());
    for (const key of ROUTE_KEYS) {
      if (ROUTE_OWNERS[key] === 'WP1') assert.ok(registered.has(key), `${key} is not registered`);
    }
  });

  test('every WP1 route refuses a missing or wrong token with 401', async (t) => {
    const core = await useServedCore(t);
    const calls: [string, { method?: string; body?: unknown }][] = [
      ['/settings', {}],
      ['/settings', { method: 'PUT', body: {} }],
      ['/changes', {}],
      ['/designs', {}],
      ['/designs', { method: 'POST', body: { kind: 'canvas' } }],
      ['/designs/whatever', {}],
      ['/designs/whatever', { method: 'PATCH', body: { title: 'x' } }],
      ['/designs/whatever', { method: 'DELETE' }],
      ['/designs/whatever/comments', { method: 'POST', body: {} }],
      ['/designs/whatever/comments/c_aaaa1111', { method: 'PATCH', body: {} }],
      ['/designs/whatever/comments/c_aaaa1111', { method: 'DELETE' }],
      ['/designs/whatever/comments/mark-sent', { method: 'POST', body: {} }],
      ['/uploads', { method: 'POST', body: {} }],
      ['/uploads/u_abcdefgh12345678/0', { method: 'PUT', body: {} }],
      ['/outbox', {}],
      ['/outbox', { method: 'PUT', body: {} }],
      ['/outbox', { method: 'DELETE' }],
    ];
    for (const [pathname, init] of calls) {
      for (const token of [null, 'wrong'] as const) {
        const answer = await core.request(pathname, { ...init, token });
        assert.equal(answer.status, 401, `${init.method ?? 'GET'} ${pathname} token=${String(token)}`);
        assert.equal((await errorOf(answer)).error, 'unauthorized');
      }
    }
  });
});

describe('GET/PUT /settings', () => {
  test('the answer describes the root, defaults, previous roots, chrome and downloads dir', async (t) => {
    const core = await useServedCore(t);
    const answer = await core.request('/settings');
    assert.equal(answer.status, 200);
    const settings = await json<SettingsResponse>(answer);
    assert.equal(settings.root, core.root);
    assert.equal(settings.defaultRoot, path.join(core.homeDir, 'Documents', 'Designs'));
    assert.equal(settings.rootExists, true);
    assert.deepEqual(settings.previousRoots, []);
    // No setting: whatever this machine has installed ('detected') or 'none'.
    assert.deepEqual(settings.chrome, resolveBrowser({}));
    assert.ok(settings.downloadsDir.length > 0);
  });

  test('changing the root never moves files and records previousRoots with live counts', async (t) => {
    const core = await useServedCore(t);
    const created = await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Kept design' } });
    assert.equal(created.status, 200);

    const rootB = core.tmp.at('root-b');
    const put = await core.request('/settings', { method: 'PUT', body: { root: rootB } });
    assert.equal(put.status, 200);
    const after = await json<SettingsResponse>(put);
    assert.equal(after.root, path.resolve(rootB));
    assert.equal(after.rootExists, true);
    assert.equal(after.previousRoots.length, 1);
    assert.equal(after.previousRoots[0]?.path, core.root);
    assert.equal(after.previousRoots[0]?.exists, true);
    assert.equal(after.previousRoots[0]?.designCount, 1);

    // The design is untouched in the old root; the new root lists empty.
    const kept = await readFile(path.join(core.root, 'kept-design', 'design.json'), 'utf8');
    assert.ok(kept.includes('Kept design'));
    const list = await json<DesignListResponse>(await core.request('/designs'));
    assert.equal(list.root, path.resolve(rootB));
    assert.deepEqual(list.designs, []);

    // Switch back: the designs reappear, root B joins previousRoots.
    const back = await json<SettingsResponse>(await core.request('/settings', { method: 'PUT', body: { root: core.root } }));
    assert.equal(back.root, core.root);
    assert.equal(back.previousRoots[0]?.path, path.resolve(rootB));
    assert.equal(back.previousRoots[0]?.designCount, 0);
    const relisted = await json<DesignListResponse>(await core.request('/designs'));
    assert.deepEqual(relisted.designs.map((design) => design.slug), ['kept-design']);
  });

  test('invalid roots are refused with 400 bad-path, and the settings stay put', async (t) => {
    const core = await useServedCore(t);
    for (const root of ['relative/path', process.platform === 'win32' ? 'C:\\' : '/', path.join(REPO_ROOT, 'designs-here'), core.homeDir, path.join(core.homeDir, 'Documents')]) {
      const answer = await core.request('/settings', { method: 'PUT', body: { root } });
      assert.equal(answer.status, 400, root);
      assert.equal((await errorOf(answer)).error, 'bad-path');
    }
    const settings = await json<SettingsResponse>(await core.request('/settings'));
    assert.equal(settings.root, core.root);
    assert.deepEqual(settings.previousRoots, []);
  });

  test('body validation: empty patch, wrong types, chromePath set and cleared', async (t) => {
    const core = await useServedCore(t);
    assert.equal((await core.request('/settings', { method: 'PUT', body: {} })).status, 400);
    assert.equal((await core.request('/settings', { method: 'PUT', body: 'nope' })).status, 400);
    assert.equal((await core.request('/settings', { method: 'PUT', body: { root: 42 } })).status, 400);
    assert.equal((await core.request('/settings', { method: 'PUT', body: { chromePath: '  ' } })).status, 400);

    // A setting that points at an existing file wins; one that does not falls back to detection.
    const chrome = await core.tmp.write('browser/chrome.exe', 'not really a browser');
    const set = await json<SettingsResponse>(await core.request('/settings', { method: 'PUT', body: { chromePath: chrome } }));
    assert.deepEqual(set.chrome, { path: chrome, source: 'setting' });
    const gone = await json<SettingsResponse>(await core.request('/settings', { method: 'PUT', body: { chromePath: core.tmp.at('browser/missing.exe') } }));
    assert.deepEqual(gone.chrome, resolveBrowser({}));
    const cleared = await json<SettingsResponse>(await core.request('/settings', { method: 'PUT', body: { chromePath: null } }));
    assert.deepEqual(cleared.chrome, resolveBrowser({}));
  });
});

describe('designs CRUD over HTTP', () => {
  test('create, list, detail, rename, trash', async (t) => {
    const core = await useServedCore(t);
    const created = await json<CreateDesignResponse>(
      await core.request('/designs', { method: 'POST', body: { kind: 'artifact', title: 'Hero page', html: '<!doctype html><h1>Hero</h1>', brief: 'A hero', sessionId: 'ses_x' } }),
    );
    assert.equal(created.slug, 'hero-page');
    assert.equal(created.path, path.join(core.root, 'hero-page'));
    assert.equal(created.design.kind, 'artifact');
    assert.equal(created.design.sessionId, 'ses_x');

    const list = await json<DesignListResponse>(await core.request('/designs'));
    assert.equal(list.root, core.root);
    assert.equal(list.designs.length, 1);
    assert.equal(list.designs[0]?.slug, 'hero-page');
    assert.equal(list.designs[0]?.pending, false);
    assert.equal(list.designs[0]?.openComments, 0);
    assert.deepEqual(list.designs[0]?.thumb, { state: 'unavailable', key: null });

    const detail = await json<DesignDetailResponse>(await core.request('/designs/hero-page'));
    assert.equal(detail.files.entry?.exists, true);
    assert.equal(detail.design.title, 'Hero page');
    assert.equal(await readFile(path.join(created.path, 'index.html'), 'utf8'), '<!doctype html><h1>Hero</h1>');

    const renamed = await json<PatchDesignResponse>(await core.request('/designs/hero-page', { method: 'PATCH', body: { title: 'Hero v2' } }));
    assert.equal(renamed.design.title, 'Hero v2');

    const deleted = await json<DeleteDesignResponse>(await core.request('/designs/hero-page', { method: 'DELETE' }));
    assert.match(path.basename(deleted.trashedTo), /^hero-page-\d{14}$/);
    assert.ok(deleted.trashedTo.startsWith(path.join(core.root, '.trash')));
    assert.equal((await core.request('/designs/hero-page')).status, 404);
    const empty = await json<DesignListResponse>(await core.request('/designs'));
    assert.deepEqual(empty.designs, []);
  });

  test('filters: q matches title or slug, kind narrows', async (t) => {
    const core = await useServedCore(t);
    await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Checkout wall' } });
    await core.request('/designs', { method: 'POST', body: { kind: 'artifact', title: 'Checkout mail' } });
    const byKind = await json<DesignListResponse>(await core.request('/designs', { query: { kind: 'artifact' } }));
    assert.deepEqual(byKind.designs.map((design) => design.slug), ['checkout-mail']);
    const byQ = await json<DesignListResponse>(await core.request('/designs', { query: { q: 'wall' } }));
    assert.deepEqual(byQ.designs.map((design) => design.slug), ['checkout-wall']);
    const both = await json<DesignListResponse>(await core.request('/designs', { query: { q: 'checkout', kind: 'canvas' } }));
    assert.deepEqual(both.designs.map((design) => design.slug), ['checkout-wall']);
    assert.equal((await core.request('/designs', { query: { kind: 'nope' } })).status, 400);
  });

  test('create refusals: bad kind, html on canvas, oversized html, unknown upload', async (t) => {
    const core = await useServedCore(t);
    assert.equal((await errorOf(await core.request('/designs', { method: 'POST', body: { kind: 'nope' } }))).error, 'bad-request');
    assert.equal((await core.request('/designs', { method: 'POST', body: 'x' })).status, 400);
    assert.equal((await errorOf(await core.request('/designs', { method: 'POST', body: { kind: 'canvas', html: '<h1>x</h1>' } }))).error, 'bad-request');
    const huge = await core.request('/designs', { method: 'POST', body: { kind: 'artifact', html: 'x'.repeat(60_001) } });
    assert.equal(huge.status, 413);
    assert.equal((await errorOf(huge)).error, 'too-large');
    const missingUpload = await core.request('/designs', { method: 'POST', body: { kind: 'artifact', uploadId: 'u_doesnotexist00' } });
    assert.equal(missingUpload.status, 404);
    assert.equal((await errorOf(await core.request('/designs', { method: 'POST', body: { kind: 'canvas', preset: 'NOT A PRESET' } }))).error, 'bad-request');
  });

  test('slug refusals: bad pattern is 400 bad-slug, traversal never reaches the filesystem', async (t) => {
    const core = await useServedCore(t);
    for (const slug of ['UPPER', 'with space', 'a..b', '.hidden']) {
      const answer = await core.request(`/designs/${encodeURIComponent(slug)}`);
      assert.equal(answer.status, 400, slug);
      assert.equal((await errorOf(answer)).error, 'bad-slug');
    }
    for (const raw of ['..%2F..%2Fsecret', '..%5C..%5Csecret', '%2e%2e%2f%2e%2e']) {
      const answer = await core.request(`/designs/${raw}`);
      assert.equal(answer.status, 400, raw);
      assert.equal((await errorOf(answer)).error, 'bad-path');
    }
  });

  test('patch refusals: empty patch, bad title, bad sessionId', async (t) => {
    const core = await useServedCore(t);
    await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Patch me' } });
    assert.equal((await core.request('/designs/patch-me', { method: 'PATCH', body: {} })).status, 400);
    assert.equal((await core.request('/designs/patch-me', { method: 'PATCH', body: { title: '' } })).status, 400);
    assert.equal((await core.request('/designs/patch-me', { method: 'PATCH', body: { title: 'x'.repeat(121) } })).status, 400);
    assert.equal((await core.request('/designs/patch-me', { method: 'PATCH', body: { sessionId: 42 } })).status, 400);
    const ok = await core.request('/designs/patch-me', { method: 'PATCH', body: { sessionId: null } });
    assert.equal(ok.status, 200);
  });

  test('a project folder must be an absolute path on create and patch', async (t) => {
    const core = await useServedCore(t);
    for (const projectDirectory of ['relative/dir', '..\\..\\Windows', `${core.root}\0x`]) {
      const created = await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Project', projectDirectory } });
      assert.equal(created.status, 400, projectDirectory);
      assert.equal((await errorOf(created)).error, 'bad-path');
    }
    const ok = await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Project', projectDirectory: core.root } });
    assert.equal(ok.status, 200);
    const patched = await core.request('/designs/project', { method: 'PATCH', body: { projectDirectory: 'relative/dir' } });
    assert.equal(patched.status, 400);
    assert.equal((await errorOf(patched)).error, 'bad-path');
    assert.equal((await core.request('/designs/project', { method: 'PATCH', body: { projectDirectory: null } })).status, 200);
  });
});

describe('comments over HTTP', () => {
  test('create, patch, mark-sent and delete round-trip through state.json and the mirror', async (t) => {
    const core = await useServedCore(t);
    const created = await json<CreateDesignResponse>(await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Commentable' } }));

    const posted = await core.request(`/designs/${created.slug}/comments`, { method: 'POST', body: { screen: null, viewport: 'laptop', anchor, body: 'Fix this heading' } });
    assert.equal(posted.status, 200);
    const { comment } = await json<CommentResponse>(posted);
    assert.match(comment.id, /^c_[a-z0-9]{12}$/);
    assert.equal(comment.status, 'open');
    assert.equal(comment.body, 'Fix this heading');

    const detail = await json<DesignDetailResponse>(await core.request(`/designs/${created.slug}`));
    assert.equal(detail.design.comments.length, 1);
    const onDisk = JSON.parse(await readFile(path.join(created.path, 'design.json'), 'utf8')) as { comments: unknown[] };
    assert.equal(onDisk.comments.length, 1, 'the mirror carries the comment');

    const patched = await json<CommentResponse>(await core.request(`/designs/${created.slug}/comments/${comment.id}`, { method: 'PATCH', body: { status: 'resolved', body: 'Fixed now' } }));
    assert.equal(patched.comment.status, 'resolved');
    assert.equal(patched.comment.body, 'Fixed now');

    const sent = await json<MarkSentResponse>(await core.request(`/designs/${created.slug}/comments/mark-sent`, { method: 'POST', body: { ids: [comment.id], version: 4 } }));
    assert.equal(sent.comments.length, 1);
    assert.equal(sent.comments[0]?.status, 'sent');
    assert.equal(sent.comments[0]?.sentVersion, 4);

    const deleted = await json<OkResponse>(await core.request(`/designs/${created.slug}/comments/${comment.id}`, { method: 'DELETE' }));
    assert.deepEqual(deleted, { ok: true });
    const after = await json<DesignDetailResponse>(await core.request(`/designs/${created.slug}`));
    assert.deepEqual(after.design.comments, []);
    assert.equal((await core.request(`/designs/${created.slug}/comments/${comment.id}`, { method: 'DELETE' })).status, 404);
  });

  test('validation: bad anchor, empty body, unknown screen type, bad ids', async (t) => {
    const core = await useServedCore(t);
    const created = await json<CreateDesignResponse>(await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Validate me' } }));
    const post = (body: unknown) => core.request(`/designs/${created.slug}/comments`, { method: 'POST', body });
    assert.equal((await post({ screen: null, viewport: 'laptop', anchor: { ...anchor, point: { x: 5, y: 0 } }, body: 'x' })).status, 400);
    assert.equal((await post({ screen: null, viewport: 'laptop', anchor, body: '' })).status, 400);
    assert.equal((await post({ screen: 'NOT A SCREEN', viewport: 'laptop', anchor, body: 'x' })).status, 400);
    assert.equal((await post({ screen: null, viewport: '', anchor, body: 'x' })).status, 400);
    assert.equal((await post('nope')).status, 400);

    assert.equal((await core.request(`/designs/${created.slug}/comments/c_bad!`, { method: 'PATCH', body: { status: 'open' } })).status, 400);
    assert.equal((await core.request(`/designs/${created.slug}/comments/c_aaaa1111`, { method: 'PATCH', body: { status: 'nope' } })).status, 400);
    assert.equal((await core.request(`/designs/${created.slug}/comments/c_aaaa1111`, { method: 'PATCH', body: {} })).status, 400);
    const markSent = await core.request(`/designs/${created.slug}/comments/mark-sent`, { method: 'POST', body: { ids: ['not-an-id'], version: null } });
    assert.equal(markSent.status, 400);
    assert.equal((await core.request(`/designs/${created.slug}/comments/mark-sent`, { method: 'POST', body: { ids: [], version: null } })).status, 400);
    assert.equal((await core.request(`/designs/${created.slug}/comments/mark-sent`, { method: 'POST', body: { ids: ['c_aaaa1111'], version: 0 } })).status, 400);
    // A valid mark-sent with no matching ids answers an empty list (idempotent).
    const none = await json<MarkSentResponse>(await core.request(`/designs/${created.slug}/comments/mark-sent`, { method: 'POST', body: { ids: ['c_aaaa1111'], version: null } }));
    assert.deepEqual(none.comments, []);
  });
});

describe('GET /changes long-poll', () => {
  test('the first call resets; a poll wakes early on a change; a quiet poll times out', async (t) => {
    const core = await useServedCore(t);
    const first = await json<ChangesResponse>(await core.request('/changes', { query: { since: '0', epoch: '' } }));
    assert.equal(first.reset, true, 'the first call answers reset:true (WP0 deviation 6)');
    assert.deepEqual(first.events, []);
    const epoch = first.epoch;

    const started = Date.now();
    const timedOut = await json<ChangesResponse>(await core.request('/changes', { query: { since: String(first.seq), epoch, wait: '200' } }));
    const waited = Date.now() - started;
    assert.ok(waited >= 150, `returned after only ${waited} ms`);
    assert.equal(timedOut.reset, false);
    assert.deepEqual(timedOut.events, []);

    const wakeStart = Date.now();
    const waiting = core.request('/changes', { query: { since: String(timedOut.seq), epoch, wait: '10000' } }).then((answer) => json<ChangesResponse>(answer));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const created = await core.request('/designs', { method: 'POST', body: { kind: 'canvas', title: 'Wakes the poll' } });
    assert.equal(created.status, 200);
    const woken = await waiting;
    assert.ok(Date.now() - wakeStart < 5000, 'the long-poll did not wake on the change');
    assert.equal(woken.reset, false);
    assert.ok(woken.events.some((event) => event.kind === 'added' && event.slug === 'wakes-the-poll'));
    assert.equal(woken.seq, woken.events[woken.events.length - 1]?.seq);
  });

  test('query validation and aborts survive', async (t) => {
    const core = await useServedCore(t);
    assert.equal((await core.request('/changes', { query: { since: 'abc' } })).status, 400);
    assert.equal((await core.request('/changes', { query: { since: '-3' } })).status, 400);
    assert.equal((await core.request('/changes', { query: { wait: 'nope' } })).status, 400);

    const first = await json<ChangesResponse>(await core.request('/changes', { query: { since: '0', epoch: '' } }));
    const controller = new AbortController();
    const pending = core
      .request('/changes', { query: { since: String(first.seq), epoch: first.epoch, wait: '10000' }, signal: controller.signal })
      .catch(() => null);
    setTimeout(() => controller.abort(), 120);
    await pending;
    // The server is still healthy after an aborted long-poll.
    assert.equal((await core.request('/health')).status, 200);
    const after = await core.request('/changes', { query: { since: String(first.seq), epoch: first.epoch, wait: '0' } });
    assert.equal(after.status, 200);
  });
});

describe('uploads over HTTP', () => {
  test('200 000 multi-byte chars reassemble byte-exact into a new artifact', async (t) => {
    const core = await useServedCore(t);
    // Built by appending whole alphabet entries (never sliced), so no surrogate pair is cut
    // — the text must survive the disk round-trip byte-exact.
    const alphabet = ['<!doctype html>\n<h1>', 'a', 'é', '漢', '🙂', 'ß', '</h1>\n'];
    let text = '';
    while (text.length < 200_000) text += alphabet[text.length % alphabet.length] ?? 'x';
    assert.ok(text.length >= 200_000, `text is only ${text.length} chars`);
    assert.equal(Buffer.byteLength(text, 'utf8') > text.length, true, 'the text is genuinely multi-byte');

    const created = await json<CreateUploadResponse>(await core.request('/uploads', { method: 'POST', body: { total: text.length } }));
    const chunks = chunkText(text);
    assert.ok(chunks.length >= 4, `expected a multi-chunk upload, got ${chunks.length}`);
    let index = 0;
    for (const chunk of chunks) {
      const answer = await core.request(`/uploads/${created.uploadId}/${index}`, { method: 'PUT', body: { data: chunk } });
      assert.equal(answer.status, 200, `chunk ${index} failed`);
      const put = await json<PutUploadChunkResponse>(answer);
      index += 1;
      assert.equal(put.complete, index === chunks.length);
    }

    const design = await json<CreateDesignResponse>(
      await core.request('/designs', { method: 'POST', body: { kind: 'artifact', title: 'Big upload', uploadId: created.uploadId } }),
    );
    assert.equal(design.slug, 'big-upload');
    assert.equal(await readFile(path.join(design.path, 'index.html'), 'utf8'), text);
    // The upload is consumed: reusing it is a 404.
    assert.equal((await core.request('/designs', { method: 'POST', body: { kind: 'artifact', uploadId: created.uploadId } })).status, 404);
  });

  test('refusals: bad total, chunk out of order, oversized chunk, unknown upload', async (t) => {
    const core = await useServedCore(t);
    assert.equal((await core.request('/uploads', { method: 'POST', body: { total: 2_000_001 } })).status, 413);
    assert.equal((await core.request('/uploads', { method: 'POST', body: { total: 'lots' } })).status, 400);
    assert.equal((await core.request('/uploads/u_nope0000000000/0', { method: 'PUT', body: { data: 'x' } })).status, 404);

    const { uploadId } = await json<CreateUploadResponse>(await core.request('/uploads', { method: 'POST', body: { total: 100 } }));
    assert.equal((await core.request(`/uploads/${uploadId}/1`, { method: 'PUT', body: { data: 'x' } })).status, 409);
    assert.equal((await core.request(`/uploads/${uploadId}/x`, { method: 'PUT', body: { data: 'x' } })).status, 400);
    assert.equal((await core.request(`/uploads/${uploadId}/0`, { method: 'PUT', body: { data: 42 } })).status, 400);
    const huge = await core.request(`/uploads/${uploadId}/0`, { method: 'PUT', body: { data: 'x'.repeat(60_001) } });
    assert.equal(huge.status, 413);
  });
});

describe('outbox over HTTP', () => {
  const body = { sessionId: 'ses_target', slug: 'my-design', text: '[Design Chamber] Revise "My design" — 1 comment(s).', commentIds: ['c_aaaa1111'], version: 3 };

  test('put, get and exactly-once delete', async (t) => {
    const core = await useServedCore(t);
    assert.deepEqual(await json<OutboxResponse>(await core.request('/outbox')), { outbox: null });

    const put = await json<OutboxResponse>(await core.request('/outbox', { method: 'PUT', body }));
    assert.equal(put.outbox?.sessionId, 'ses_target');
    assert.equal(put.outbox?.slug, 'my-design');
    const got = await json<OutboxResponse>(await core.request('/outbox'));
    assert.deepEqual(got.outbox, put.outbox);
    const taken = await json<OutboxResponse>(await core.request('/outbox', { method: 'DELETE' }));
    assert.deepEqual(taken.outbox, put.outbox);
    assert.deepEqual(await json<OutboxResponse>(await core.request('/outbox')), { outbox: null });
    assert.deepEqual(await json<OutboxResponse>(await core.request('/outbox', { method: 'DELETE' })), { outbox: null });
  });

  test('validation: slug, text and ids', async (t) => {
    const core = await useServedCore(t);
    assert.equal((await errorOf(await core.request('/outbox', { method: 'PUT', body: { ...body, slug: 'BAD SLUG' } }))).error, 'bad-slug');
    assert.equal((await core.request('/outbox', { method: 'PUT', body: { ...body, text: '' } })).status, 400);
    assert.equal((await core.request('/outbox', { method: 'PUT', body: { ...body, text: 'x'.repeat(16_001) } })).status, 400);
    assert.equal((await core.request('/outbox', { method: 'PUT', body: { ...body, commentIds: 'nope' } })).status, 400);
    assert.equal((await core.request('/outbox', { method: 'PUT', body: { ...body, sessionId: '' } })).status, 400);
    assert.equal((await core.request('/outbox', { method: 'PUT', body: { ...body, version: 'v3' } })).status, 400);
    assert.equal((await core.request('/outbox', { method: 'PUT', body: 'x' })).status, 400);
  });
});
