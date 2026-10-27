// The composed service (docs/SPEC.md §9.7): every lane's real module wired into one
// ServiceContext and every lane's routes registered on one router. `main.ts` serves it as the
// host's service process; integration tests compose it in-process the same way.

import { randomUUID } from 'node:crypto';

import { createChangeHub } from './changes.ts';
import { unavailable, type Logger, type ServiceContext } from './context.ts';
import { createRouter, registerHealthRoute, type Router } from './http.ts';
import { createOutboxStore } from './outbox.ts';
import { ensureRenderService } from './render-cache.ts';
import { registerChangesRoutes } from './routes/changes.ts';
import { registerChatRoutes } from './routes/chat.ts';
import { registerCommentsRoutes } from './routes/comments.ts';
import { registerDesignsRoutes } from './routes/designs.ts';
import { registerExportRoutes } from './routes/export.ts';
import { registerOutboxRoutes } from './routes/outbox.ts';
import { registerPresetsRoutes } from './routes/presets.ts';
import { registerRenderRoutes } from './routes/render.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerThumbnailsRoutes } from './routes/thumbnails.ts';
import { registerUploadsRoutes } from './routes/uploads.ts';
import { registerVersionsRoutes } from './routes/versions.ts';
import { createSettingsStore, type SettingsEnv } from './settings.ts';
import { createDesignStore } from './store.ts';
import { ensureThumbnailService } from './thumbnails.ts';
import { createUploadStore } from './uploads.ts';
import { startWatcher, type WatcherOptions } from './watch.ts';

export type ComposeOptions = {
  token: string;
  log: Logger;
  packageRoot: string;
  version: string;
  /** Settings-file location seam (`DC_SETTINGS_PATH`); defaults to `process.env`. */
  env?: SettingsEnv;
  homeDir?: string;
  /** Watcher timing seams for tests. */
  watch?: Pick<WatcherOptions, 'pollMs' | 'debounceMs'>;
};

export type ComposedService = {
  ctx: ServiceContext;
  router: Router;
  /** Run every `onDispose` callback (reverse order); failures are logged, never thrown. */
  dispose(): Promise<void>;
};

export const composeService = async (options: ComposeOptions): Promise<ComposedService> => {
  const { log, packageRoot } = options;
  const disposers: (() => void | Promise<void>)[] = [];

  const settings = await createSettingsStore({
    log,
    packageRoot,
    ...(options.env ? { env: options.env } : {}),
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const epoch = randomUUID();
  const hub = createChangeHub(epoch);
  // The store reads list thumb states from the thumbnail service, which itself needs the store:
  // the store asks through the context, which holds the real service before any request runs.
  const store = createDesignStore({ settings, log, hub, thumbnails: { peek: (slug) => ctx.thumbnails.peek(slug) } });

  const ctx: ServiceContext = {
    packageRoot,
    version: options.version,
    epoch,
    log,
    settings,
    store,
    hub,
    uploads: createUploadStore(),
    outbox: createOutboxStore(),
    renders: unavailable('rendering'),
    thumbnails: unavailable('thumbnails'),
    onDispose: (fn) => {
      disposers.push(fn);
    },
  };
  // Eager, so the versions service (created with the render service) takes quiet-period
  // snapshots from the first content event on, and the routes share these same instances.
  ctx.renders = ensureRenderService(ctx);
  ctx.thumbnails = ensureThumbnailService(ctx);

  const watcher = startWatcher({ settings, hub, log, ...options.watch });
  ctx.onDispose(() => watcher.stop());

  const router = createRouter({ token: options.token, log });
  registerHealthRoute(router, { version: ctx.version, epoch: ctx.epoch });
  // WP1
  registerSettingsRoutes(router, ctx);
  registerChangesRoutes(router, ctx);
  registerDesignsRoutes(router, ctx);
  registerCommentsRoutes(router, ctx);
  registerUploadsRoutes(router, ctx);
  registerOutboxRoutes(router, ctx);
  // WP2
  registerRenderRoutes(router, ctx);
  registerVersionsRoutes(router, ctx);
  registerExportRoutes(router, ctx);
  registerThumbnailsRoutes(router, ctx);
  // WP3 (registers the RULES.md `onCreate` hook on the real store)
  registerPresetsRoutes(router, ctx);
  registerChatRoutes(router, ctx);

  let disposed = false;
  return {
    ctx,
    router,
    async dispose() {
      if (disposed) return;
      disposed = true;
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch (error) {
          log.warn('service.dispose-failed', { error: error instanceof Error ? error.message : String(error) });
        }
      }
    },
  };
};
