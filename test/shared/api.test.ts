import assert from 'node:assert/strict';
import { test } from 'node:test';

import { API_ERROR_STATUS, isApiErrorCode, RAW_TEXT_ROUTES, ROUTE_KEYS, ROUTE_OWNERS, routePath, splitRouteKey } from '../../src/shared/api.ts';

test('the route table lists every §7 route once, each with an owner lane', () => {
  assert.equal(ROUTE_KEYS.length, 35);
  assert.equal(new Set(ROUTE_KEYS).size, ROUTE_KEYS.length);
  for (const key of ROUTE_KEYS) {
    const { method, pattern } = splitRouteKey(key);
    assert.match(method, /^(GET|POST|PUT|PATCH|DELETE)$/);
    assert.match(pattern, /^\/[a-z/:-]*$/i, key);
    assert.ok(ROUTE_OWNERS[key]);
  }
  for (const key of RAW_TEXT_ROUTES) assert.ok(ROUTE_KEYS.includes(key));
});

test('routePath fills and percent-encodes params', () => {
  assert.equal(routePath('GET /designs/:slug', { slug: 'checkout' }), '/designs/checkout');
  assert.equal(routePath('PATCH /designs/:slug/comments/:id', { slug: 'a', id: 'c_1' }), '/designs/a/comments/c_1');
  assert.equal(routePath('GET /designs/:slug', { slug: '../x/y' }), '/designs/..%2Fx%2Fy');
  assert.equal(routePath('GET /health', {}), '/health');
  assert.throws(() => routePath('GET /designs/:slug', { slug: '' }), /Missing path parameter "slug"/);
});

test('error codes map to the §7 statuses', () => {
  assert.equal(API_ERROR_STATUS['bad-slug'], 400);
  assert.equal(API_ERROR_STATUS.stale, 409);
  assert.equal(API_ERROR_STATUS['too-large'], 413);
  assert.equal(API_ERROR_STATUS['no-html'], 422);
  assert.equal(isApiErrorCode('conflict'), true);
  assert.equal(isApiErrorCode('constructor'), false);
});
