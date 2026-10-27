// Shared fixtures for the WP3 tests: an agent context, a context whose store can create
// designs (the fake store of test/helpers is read-only), and a real router + loopback server so
// route tests go through bearer auth and path decoding exactly as the host's proxy does.

import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { TestContext } from 'node:test';

import { noProject, type AgentContext } from '../../src/shared/agent/context.ts';
import { createDesignDocument, defaultViewports, serializeJson } from '../../src/shared/design-json.ts';
import type { Comment, JsonObject } from '../../src/shared/types.ts';
import type { CreateDesignInput, DesignRecord, DesignStore, ServiceContext } from '../../src/service/context.ts';
import { createRouter, createServiceServer, listenLoopback } from '../../src/service/http.ts';
import { registerChatRoutes } from '../../src/service/routes/chat.ts';
import { registerPresetsRoutes } from '../../src/service/routes/presets.ts';
import { createFakeContext, type FakeContext } from '../helpers/fake-context.ts';
import type { TmpRoot } from '../helpers/tmp-root.ts';

export const TOKEN = 'wp3-test-token-0123456789';

export const baseContext = (overrides: Partial<AgentContext> = {}): AgentContext => ({
  title: 'Pricing page for a coffee subscription',
  kind: 'canvas',
  folder: 'C:\\Users\\you\\Documents\\Designs\\pricing-page',
  brief: 'A pricing page for a coffee subscription. Three plans, mobile first.',
  project: noProject('the chat has no project folder'),
  preset: null,
  viewports: defaultViewports('canvas'),
  screenIds: [],
  pending: true,
  designSystem: { confirmed: false, hasDesignMd: false, hasTokensCss: false },
  ...overrides,
});

export type ChatTestContext = FakeContext & {
  /** What `store.create` was called with, in order. */
  creates: CreateDesignInput[];
};

/** A fake context whose store also creates designs on disk and runs the registered `onCreate` hooks. */
export const createChatContext = (tmp: TmpRoot, overrides: Partial<ServiceContext> = {}): ChatTestContext => {
  const base = createFakeContext({ root: tmp.root });
  const hooks: ((record: DesignRecord) => Promise<void>)[] = [];
  const creates: CreateDesignInput[] = [];

  const create = async (input: CreateDesignInput): Promise<DesignRecord> => {
    creates.push(input);
    const slug = `${(input.title ?? input.kind).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'design'}-${creates.length}`;
    await mkdir(tmp.at(slug), { recursive: true });
    const { state, json } = createDesignDocument({
      kind: input.kind,
      title: input.title ?? slug,
      brief: input.brief ?? '',
      sessionId: input.sessionId ?? null,
      projectDirectory: input.projectDirectory ?? null,
      preset: input.preset ?? null,
      now: new Date().toISOString(),
    });
    await tmp.write(`${slug}/.chamber/state.json`, serializeJson(state as unknown as JsonObject));
    await tmp.write(`${slug}/design.json`, serializeJson(json));
    if (input.html !== undefined) await tmp.write(`${slug}/index.html`, input.html);
    const record = await base.store.get(slug);
    for (const hook of hooks) await hook(record);
    return record;
  };

  const store = new Proxy(base.store, {
    get(target, property, receiver) {
      if (property === 'create') return create;
      if (property === 'onCreate') {
        return (hook: (record: DesignRecord) => Promise<void>) => {
          hooks.push(hook);
          return () => void hooks.splice(hooks.indexOf(hook), 1);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as DesignStore;

  return Object.assign(base, { store, creates, ...overrides });
};

/** Write a design folder the way WP1's store would, with comments and screens. */
export const seedDesign = async (
  tmp: TmpRoot,
  slug: string,
  options: { kind?: 'canvas' | 'artifact'; comments?: Comment[]; screens?: { id: string; title: string }[]; title?: string; projectDirectory?: string | null } = {},
): Promise<void> => {
  const kind = options.kind ?? 'canvas';
  const { state, json } = createDesignDocument({
    kind,
    title: options.title ?? 'Checkout redesign',
    brief: 'Redesign the checkout.',
    sessionId: null,
    projectDirectory: options.projectDirectory ?? null,
    preset: null,
    now: '2026-10-26T18:00:00.000Z',
  });
  const withComments = { ...state, comments: options.comments ?? [] };
  const design: JsonObject = {
    ...json,
    comments: (options.comments ?? []) as unknown as JsonObject[],
    ...(kind === 'canvas' ? { screens: (options.screens ?? [{ id: 'home', title: 'Home' }]).map((s) => ({ ...s, file: `screens/${s.id}.html` })) } : {}),
  };
  await tmp.write(`${slug}/.chamber/state.json`, serializeJson(withComments as unknown as JsonObject));
  await tmp.write(`${slug}/design.json`, serializeJson(design));
};

export const comment = (id: string, overrides: Partial<Comment> = {}): Comment => ({
  id,
  screen: 'home',
  viewport: 'laptop',
  anchor: {
    selector: 'main > section.hero > h1',
    text: 'Ship faster than ever before',
    html: '<h1 class="hero-title">',
    rect: { x: 120, y: 340, w: 600, h: 64 },
    point: { x: 0.12, y: 0.5 },
  },
  body: 'Make this shorter',
  status: 'open',
  created: '2026-10-26T18:10:00.000Z',
  sentAt: null,
  sentVersion: null,
  ...overrides,
});

export type Reply = { status: number; json: Record<string, unknown> };

/** The chat + presets routes behind a real router and a loopback server. */
export const serveRoutes = async (t: TestContext, ctx: ServiceContext) => {
  const router = createRouter({ token: TOKEN, log: ctx.log });
  registerPresetsRoutes(router, ctx);
  registerChatRoutes(router, ctx);
  const server = createServiceServer(router);
  await listenLoopback(server, 0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const call = async (route: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<Reply> => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.token === null ? {} : { authorization: `Bearer ${init.token ?? TOKEN}` },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return { call, router };
};

/** Assert a reply is an ApiError body with this status and code. */
export const assertError = (reply: Reply, status: number, code: string): void => {
  assert.equal(reply.status, status, JSON.stringify(reply.json));
  assert.equal(reply.json.error, code);
  assert.equal(typeof reply.json.message, 'string');
};

export const REPO_RULES = path.resolve(import.meta.dirname, '..', '..', 'rules');
