// Shared wiring for the WP1 core tests: the REAL WP1 modules (settings store, change hub,
// designs store, uploads, outbox, optional watcher) composed into a ServiceContext exactly
// the way main.ts will at integration, then served through the real router over loopback
// HTTP so routes are exercised like the host proxy calls them (bearer + JSON).

import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { TestContext } from 'node:test';

import type { ServiceContext } from '../../../src/service/context.ts';
import { createChangeHub } from '../../../src/service/changes.ts';
import { unavailable, type Logger } from '../../../src/service/context.ts';
import { createDesignStore, type DesignStoreWithReconcile } from '../../../src/service/store.ts';
import { createOutboxStore } from '../../../src/service/outbox.ts';
import { createSettingsStore } from '../../../src/service/settings.ts';
import { createUploadStore } from '../../../src/service/uploads.ts';
import { createRouter, createServiceServer, listenLoopback, registerHealthRoute, type Router } from '../../../src/service/http.ts';
import { registerChangesRoutes } from '../../../src/service/routes/changes.ts';
import { registerCommentsRoutes } from '../../../src/service/routes/comments.ts';
import { registerDesignsRoutes } from '../../../src/service/routes/designs.ts';
import { registerOutboxRoutes } from '../../../src/service/routes/outbox.ts';
import { registerSettingsRoutes } from '../../../src/service/routes/settings.ts';
import { registerUploadsRoutes } from '../../../src/service/routes/uploads.ts';
import { startWatcher, type Watcher, type WatcherOptions } from '../../../src/service/watch.ts';
import { useTmpRoot, type TmpRoot } from '../../helpers/tmp-root.ts';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
export const TEST_TOKEN = 'wp1-core-test-token';

export type LogLine = { level: 'info' | 'warn' | 'error'; event: string; fields?: Readonly<Record<string, unknown>> };

const captureLogger = (logs: LogLine[]): Logger => ({
  info: (event, fields) => void logs.push({ level: 'info', event, fields }),
  warn: (event, fields) => void logs.push({ level: 'warn', event, fields }),
  error: (event, fields) => void logs.push({ level: 'error', event, fields }),
});

export type CoreOptions = {
  /** Watcher options when `watch` is true (pollMs/debounceMs/watchImpl). */
  watch?: boolean | Omit<WatcherOptions, 'settings' | 'hub' | 'log'>;
  /** Test seam for the store clock. */
  now?: () => Date;
};

export type Core = {
  tmp: TmpRoot;
  /** The designs root the settings file points at. */
  root: string;
  /** A home dir inside tmp, so defaultRoot() never touches the real home. */
  homeDir: string;
  logs: LogLine[];
  ctx: ServiceContext;
  store: DesignStoreWithReconcile;
  watcher: Watcher | null;
  stop(): Promise<void>;
};

/** Compose the real WP1 modules over a tmp root (no watcher unless asked). */
export const createCore = async (t: TestContext, options: CoreOptions = {}): Promise<Core> => {
  const tmp = await useTmpRoot(t);
  const root = tmp.at('designs');
  const homeDir = tmp.at('home');
  await mkdir(root, { recursive: true });
  await mkdir(homeDir, { recursive: true });

  const settingsFile = tmp.at('settings.json');
  await writeFile(settingsFile, `${JSON.stringify({ version: 1, root })}\n`, 'utf8');

  const logs: LogLine[] = [];
  const log = captureLogger(logs);
  const epoch = randomUUID();
  const settings = await createSettingsStore({ log, packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: settingsFile }, homeDir });
  const hub = createChangeHub(epoch);
  const store = createDesignStore({ settings, log, hub, ...(options.now ? { now: options.now } : {}) });
  const disposers: (() => void | Promise<void>)[] = [];

  const ctx: ServiceContext = {
    packageRoot: REPO_ROOT,
    version: '0.0.0-wp1-test',
    epoch,
    log,
    settings,
    store,
    hub,
    uploads: createUploadStore(),
    outbox: createOutboxStore(),
    renders: unavailable('renders (WP2)'),
    thumbnails: { peek: () => ({ state: 'unavailable', key: null }) },
    onDispose: (fn) => void disposers.push(fn),
  };

  let watcher: Watcher | null = null;
  if (options.watch) {
    const watchOptions = options.watch === true ? {} : options.watch;
    watcher = startWatcher({ settings, hub, log, ...watchOptions });
  }

  return {
    tmp,
    root,
    homeDir,
    logs,
    ctx,
    store,
    watcher,
    async stop() {
      watcher?.stop();
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
};

export type ServedCore = Core & {
  router: Router;
  port: number;
  request(pathname: string, init?: { method?: string; query?: Record<string, string>; body?: unknown; token?: string | null; signal?: AbortSignal }): Promise<Response>;
};

/** Serve a core's WP1 routes on an ephemeral loopback port, like the host proxy does. */
export const serveCore = async (t: TestContext, core: Core): Promise<ServedCore> => {
  const log = captureLogger(core.logs);
  const router = createRouter({ token: TEST_TOKEN, log });
  registerHealthRoute(router, { version: core.ctx.version, epoch: core.ctx.epoch });
  registerSettingsRoutes(router, core.ctx);
  registerChangesRoutes(router, core.ctx);
  registerDesignsRoutes(router, core.ctx);
  registerCommentsRoutes(router, core.ctx);
  registerUploadsRoutes(router, core.ctx);
  registerOutboxRoutes(router, core.ctx);

  const server = createServiceServer(router);
  await listenLoopback(server, 0);
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port, address } = server.address() as AddressInfo;
  if (address !== '127.0.0.1') throw new Error(`The test service must bind loopback, bound ${address}.`);

  const request: ServedCore['request'] = (pathname, init = {}) => {
    const url = new URL(pathname, `http://127.0.0.1:${port}`);
    for (const [key, value] of Object.entries(init.query ?? {})) url.searchParams.set(key, value);
    const headers: Record<string, string> = {};
    const bearer = init.token === undefined ? TEST_TOKEN : init.token;
    if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    return fetch(url, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
  return { ...core, router, port, request };
};

/** A fresh served core (the common case). */
export const useServedCore = async (t: TestContext, options: CoreOptions = {}): Promise<ServedCore> => {
  const core = await createCore(t, options);
  t.after(() => core.stop());
  return serveCore(t, core);
};
