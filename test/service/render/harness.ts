// Shared harness for WP2 tests: a real HTTP server (createRouter + listenLoopback) with the
// WP2 routes registered over a fake ServiceContext — the shape §15.2 asks for, minus the WP1
// routes being built in parallel. Also standard design fixtures.

import type { AddressInfo } from 'node:net';
import type { TestContext } from 'node:test';

import { createRouter, createServiceServer, listenLoopback } from '../../../src/service/http.ts';
import { registerRenderRoutes } from '../../../src/service/routes/render.ts';
import { registerVersionsRoutes } from '../../../src/service/routes/versions.ts';
import { registerExportRoutes } from '../../../src/service/routes/export.ts';
import { registerThumbnailsRoutes } from '../../../src/service/routes/thumbnails.ts';
import { ensureVersionsService, type VersionsService } from '../../../src/service/versions.ts';
import { createRenderService, type BrandedRenderService } from '../../../src/service/render-cache.ts';
import { createFakeContext, type FakeContext, type FakeContextOptions } from '../../helpers/fake-context.ts';
import type { FileContent } from '../../helpers/tmp-root.ts';

export const TOKEN = 'wp2-test-token-0123456789';

export type Wp2Service = {
  ctx: FakeContext;
  versions: VersionsService;
  renders: BrandedRenderService;
  call(pathname: string, init?: { method?: string; body?: unknown; token?: string | null; query?: Record<string, string> }): Promise<Response>;
  json<T>(pathname: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }): Promise<T>;
};

export const startWp2 = async (t: TestContext, options: FakeContextOptions): Promise<Wp2Service> => {
  const ctx = createFakeContext(options);
  t.after(() => ctx.dispose());
  // One versions instance, shared by the routes (ensure* memoises per context object) and the
  // render service — the shape main.ts gets after integration.
  const versions = ensureVersionsService(ctx);
  const renders = createRenderService({ store: ctx.store, hub: ctx.hub, onDispose: ctx.onDispose, versions });
  ctx.renders = renders;

  const router = createRouter({ token: TOKEN, log: ctx.log });
  registerRenderRoutes(router, ctx);
  registerVersionsRoutes(router, ctx);
  registerExportRoutes(router, ctx);
  registerThumbnailsRoutes(router, ctx);

  const server = createServiceServer(router);
  await listenLoopback(server, 0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;

  const call = (pathname: string, init: { method?: string; body?: unknown; token?: string | null; query?: Record<string, string> } = {}): Promise<Response> => {
    const url = new URL(pathname, `http://127.0.0.1:${port}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    const bearer = init.token === undefined ? TOKEN : init.token;
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  };
  const json = async <T>(pathname: string, init?: { method?: string; body?: unknown; query?: Record<string, string> }): Promise<T> => {
    const answer = await call(pathname, init);
    if (!answer.ok) throw new Error(`${init?.method ?? 'GET'} ${pathname} → ${answer.status}: ${await answer.text()}`);
    return (await answer.json()) as T;
  };
  return { ctx, versions, renders, call, json };
};

// ---- fixtures ----

/** A 1×1 red PNG, base64 (the same one the thumbnail spike uses). */
export const RED_PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
export const redPng = (): Uint8Array => Uint8Array.from(Buffer.from(RED_PNG_B64, 'base64'));

export const artifactDesign = (files: Record<string, FileContent> = {}): Record<string, FileContent> => ({
  'design.json': { version: 1, kind: 'artifact', title: 'Test artifact', created: '2026-10-26T10:00:00.000Z', updated: '2026-10-26T10:00:00.000Z' },
  'index.html': '<!doctype html><html><head><title>Artifact</title></head><body><h1>hello</h1></body></html>',
  ...files,
});

export const canvasDesign = (files: Record<string, FileContent> = {}): Record<string, FileContent> => ({
  'design.json': {
    version: 1,
    kind: 'canvas',
    title: 'Test canvas',
    created: '2026-10-26T10:00:00.000Z',
    updated: '2026-10-26T10:00:00.000Z',
    screens: [
      { id: 'home', title: 'Home', file: 'screens/home.html' },
      { id: 'checkout', title: 'Checkout', file: 'screens/checkout.html' },
    ],
  },
  'screens/home.html': '<!doctype html><html><head><title>Home</title></head><body><h1>home</h1></body></html>',
  'screens/checkout.html': '<!doctype html><html><head><title>Checkout</title></head><body><h1>checkout</h1></body></html>',
  ...files,
});

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
