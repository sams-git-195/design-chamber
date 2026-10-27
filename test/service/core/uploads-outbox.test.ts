// Uploads (chunked text, TTL, open cap) and the outbox slot (exactly-once, TTL) —
// docs/SPEC.md §7, §10.4. Unit level; the HTTP surface is covered in routes.test.ts.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { ApiError } from '../../../src/service/http.ts';
import { createUploadStore } from '../../../src/service/uploads.ts';
import { createOutboxStore } from '../../../src/service/outbox.ts';
import { OUTBOX_TTL_MS, UPLOAD_ID_PATTERN, UPLOAD_TTL_MS, UPLOADS_OPEN_MAX, UPLOAD_TOTAL_MAX } from '../../../src/shared/limits.ts';

const code = (promise: () => unknown): string => {
  try {
    promise();
  } catch (error) {
    assert.ok(error instanceof ApiError, `expected ApiError, got ${String(error)}`);
    return error.code;
  }
  throw new Error('expected a throw, none happened');
};

describe('uploads', () => {
  test('create mints a pattern id; chunks join in order; take is one-shot', () => {
    const uploads = createUploadStore();
    const id = uploads.create(11);
    assert.match(id, UPLOAD_ID_PATTERN);
    assert.deepEqual(uploads.put(id, 0, 'hello'), { received: 5, complete: false });
    assert.deepEqual(uploads.put(id, 1, ' '), { received: 6, complete: false });
    assert.deepEqual(uploads.put(id, 2, 'world'), { received: 11, complete: true });
    assert.equal(uploads.take(id), 'hello world');
    assert.equal(code(() => uploads.take(id)), 'not-found');
  });

  test('out-of-order chunks conflict; over-total chunks are too-large; incomplete take conflicts', () => {
    const uploads = createUploadStore();
    const id = uploads.create(100);
    assert.equal(code(() => uploads.put(id, 1, 'x')), 'conflict');
    assert.equal(code(() => uploads.put(id, -1, 'x')), 'bad-request');
    uploads.put(id, 0, 'a'.repeat(50));
    assert.equal(code(() => uploads.put(id, 1, 'b'.repeat(51))), 'too-large');
    assert.equal(code(() => uploads.take(id)), 'conflict');
    assert.equal(code(() => uploads.put('u_does-not-exist', 0, 'x')), 'not-found');
  });

  test('a replayed or skipped-ahead chunk conflicts and stores nothing', () => {
    const uploads = createUploadStore();
    const id = uploads.create(6);
    uploads.put(id, 0, 'ab');
    uploads.put(id, 1, 'cd');
    assert.equal(code(() => uploads.put(id, 0, 'ab')), 'conflict'); // a retried earlier chunk
    assert.equal(code(() => uploads.put(id, 1, 'cd')), 'conflict'); // the last chunk sent twice
    assert.equal(code(() => uploads.put(id, 3, 'ef')), 'conflict');
    assert.deepEqual(uploads.put(id, 2, 'ef'), { received: 6, complete: true });
    assert.equal(uploads.take(id), 'abcdef');
  });

  test('total is validated', () => {
    const uploads = createUploadStore();
    assert.equal(code(() => uploads.create(UPLOAD_TOTAL_MAX + 1)), 'too-large');
    assert.equal(code(() => uploads.create(-1)), 'bad-request');
    assert.equal(code(() => uploads.create(1.5)), 'bad-request');
    assert.equal(typeof uploads.create(0), 'string'); // a zero-length upload completes immediately
  });

  test('at most UPLOADS_OPEN_MAX open uploads', () => {
    const uploads = createUploadStore();
    for (let index = 0; index < UPLOADS_OPEN_MAX; index += 1) uploads.create(10);
    assert.equal(code(() => uploads.create(10)), 'conflict');
  });

  test('uploads expire after the TTL', () => {
    let clock = 1_000_000;
    const uploads = createUploadStore({ now: () => clock });
    const id = uploads.create(5);
    uploads.put(id, 0, 'hello');
    clock += UPLOAD_TTL_MS - 1000;
    assert.equal(uploads.take(id), 'hello');
    const late = uploads.create(5);
    clock += UPLOAD_TTL_MS + 1000;
    assert.equal(code(() => uploads.put(late, 0, 'hello')), 'not-found');
    // The expired slot is swept, so a new upload fits under the cap again.
    assert.equal(typeof uploads.create(5), 'string');
  });

  test('200 000 chars including multi-byte text reassemble byte-exact', () => {
    const uploads = createUploadStore();
    const alphabet = ['a', 'é', '漢', '🙂', 'ß'];
    let text = '';
    while (text.length < 200_000) text += alphabet[text.length % alphabet.length] ?? 'x';
    text = text.slice(0, 200_000);
    const id = uploads.create(text.length);
    const chunkSize = 40_000;
    let last = { received: 0, complete: false };
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      last = uploads.put(id, offset / chunkSize, text.slice(offset, offset + chunkSize));
    }
    assert.equal(last.complete, true);
    assert.equal(last.received, text.length);
    assert.equal(uploads.take(id), text);
  });
});

describe('outbox', () => {
  const body = { sessionId: 'ses_abc', slug: 'my-design', text: 'Revise it', commentIds: ['c_aaaa1111'], version: 3 };

  test('put/get/take is exactly-once', () => {
    const outbox = createOutboxStore();
    assert.equal(outbox.get(), null);
    const stored = outbox.put(body);
    assert.equal(stored.sessionId, 'ses_abc');
    assert.ok(typeof stored.created === 'string');
    assert.deepEqual(outbox.get(), stored);
    assert.deepEqual(outbox.take(), stored);
    assert.equal(outbox.get(), null);
    assert.equal(outbox.take(), null); // DELETE twice never delivers twice
  });

  test('a newer put replaces the slot', () => {
    const outbox = createOutboxStore();
    outbox.put(body);
    const second = outbox.put({ ...body, text: 'Newer' });
    assert.equal(outbox.get()?.text, 'Newer');
    assert.equal(second.text, 'Newer');
  });

  test('text over the host cap is refused', () => {
    const outbox = createOutboxStore();
    assert.equal(code(() => outbox.put({ ...body, text: 'x'.repeat(16_001) })), 'too-large');
  });

  test('the slot expires after the TTL', () => {
    let clock = Date.parse('2026-10-26T12:00:00.000Z');
    const outbox = createOutboxStore({ now: () => clock });
    outbox.put(body);
    clock += OUTBOX_TTL_MS - 1000;
    assert.notEqual(outbox.get(), null);
    clock += 2000;
    assert.equal(outbox.get(), null);
    outbox.put(body);
    clock += OUTBOX_TTL_MS + 1;
    assert.equal(outbox.take(), null);
  });
});
