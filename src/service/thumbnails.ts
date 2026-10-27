// Thumbnails (docs/SPEC.md §4.4, §9.5): one-shot headless Chrome/Edge screenshots — the CLI
// approach proven by spikes/thumbnail/run.mjs, no CDP — cached at `<design>/.thumb.png` with
// the render key in `<design>/.chamber/thumb.json`, served as base64 JSON (F2 img-src data:).
// Queue: concurrency 1, newest-first, deduped by slug; content events re-run debounced by
// THUMB_DEBOUNCE_MS; every run is killed after THUMB_TIMEOUT_MS; the network is blocked with
// --host-resolver-rules so thumbnails match the offline in-app render. No browser at all →
// `unavailable` → the UI falls back to live mini-frames.
//
// Work folder (profile + raw screenshot): the OS temp folder on win32/darwin; on Linux the
// design's own `.chamber/` folder. A Snap or Flatpak Chromium — including Ubuntu's
// /usr/bin/chromium-browser, a Snap wrapper — runs with a private /tmp, so a screenshot written
// to the service's temp folder never appears; the design folder is the one place such a browser
// must already reach (it reads the page from there), and `.chamber/` is ignored by the watcher,
// versions and exports. Linux headless also needs --no-sandbox when the service runs as root
// (containers); headless=new needs no display.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { VIEWPORT_LAPTOP, screenFileOf, ENTRY_FILE } from '../shared/design-json.ts';
import { SLUG_PATTERN, THUMB_DEBOUNCE_MS, THUMB_TIMEOUT_MS, THUMB_WIDTH } from '../shared/limits.ts';
import type { ThumbnailRefreshResponse, ThumbnailResponse } from '../shared/api.ts';
import type { ThumbState, Viewport } from '../shared/types.ts';
import { ApiError } from './http.ts';
import type { ChangeHub, DesignRecord, DesignStore, Logger, RenderService, ServiceContext, SettingsStore, ThumbnailService } from './context.ts';
import { resolveBrowser as detectBrowser, type BrowserResolution } from './chrome.ts';
import { ensureRenderService } from './render-cache.ts';

export const THUMB_FILE = '.thumb.png';
const THUMB_META_FILE = path.join('.chamber', 'thumb.json');

/**
 * The colour scheme thumbnails are captured in: the wall's sandboxed artboard frames render
 * `prefers-color-scheme: light`, and headless Chrome would otherwise follow the OS (KI-3).
 * Part of the cache identity, so PNGs captured under another scheme are taken again.
 */
const THUMB_SCHEME = 'light';
type ThumbMeta = { key: string; createdAt: string; viewport: string; scheme: string };

export type ThumbnailServiceFull = ThumbnailService & {
  /** Brand so `ensureThumbnailService` recognises an already-wired instance. */
  __dcThumbnailService?: true;
  /** Full state for GET /designs/:slug/thumbnail; enqueues a capture when the cache is stale. */
  get(slug: string): Promise<ThumbnailResponse>;
  /** Force a fresh capture; answers the state right after enqueueing. */
  refresh(slug: string): Promise<ThumbnailRefreshResponse>;
};

export type ThumbnailDeps = {
  store: DesignStore;
  settings: SettingsStore;
  hub: ChangeHub;
  log: Logger;
  onDispose: (fn: () => void | Promise<void>) => void;
  renders: RenderService;
  /** Injectable for tests: the browser probe (defaults to chrome.ts over the settings). */
  resolveBrowser?: () => BrowserResolution;
  /** Injectable for tests: where throwaway profiles go on win32/darwin. */
  tmpdir?: () => string;
  /** Injectable for tests: the platform rules (work folder, --no-sandbox). */
  platform?: NodeJS.Platform;
  /** Injectable for tests: whether the service runs as root (Linux containers). */
  isRoot?: () => boolean;
};

const WORK_PREFIX = 'dc-thumb-';
/** A work folder this old in a design's `.chamber/` was left by a killed service: removed. */
const STALE_WORK_MS = 10 * 60_000;

/** Where a capture's throwaway work folder goes (see the header: Snap/Flatpak private /tmp). */
export const thumbWorkParent = (platform: NodeJS.Platform, designDir: string, tmpdir: string): string =>
  platform === 'win32' || platform === 'darwin' ? tmpdir : path.join(designDir, '.chamber');

export type CaptureArgsInput = {
  workDir: string;
  out: string;
  viewport: Viewport;
  scale: number;
  url: string;
  platform: NodeJS.Platform;
  isRoot: boolean;
};

/** The one-shot headless command line (SPEC §9.5, spike args + offline resolver rules). */
export const captureArgs = (input: CaptureArgsInput): string[] => [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--hide-scrollbars',
  '--mute-audio',
  // Chromium refuses to start its sandbox as root; only then is it switched off.
  ...(input.platform === 'linux' && input.isRoot ? ['--no-sandbox'] : []),
  `--user-data-dir=${path.join(input.workDir, 'profile')}`,
  `--window-size=${input.viewport.width},${input.viewport.height}`,
  `--force-device-scale-factor=${input.scale}`,
  '--virtual-time-budget=1500',
  '--blink-settings=preferredColorScheme=1', // 1 = light (Blink's enum: 0 dark, 1 light)
  `--screenshot=${input.out}`,
  '--host-resolver-rules=MAP * ~NOTFOUND',
  input.url,
];

/** Remove work folders a killed run left in `parent` (only `dc-thumb-*`, only old ones). */
const removeStaleWorkDirs = async (parent: string): Promise<void> => {
  const entries = await readdir(parent, { withFileTypes: true }).catch(() => []);
  const cutoff = Date.now() - STALE_WORK_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(WORK_PREFIX)) continue;
    const target = path.join(parent, entry.name);
    const info = await stat(target).catch(() => null);
    if (info !== null && info.mtimeMs < cutoff) await rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Width/height from the IHDR chunk, or null when this is not a PNG we understand. */
export const pngSize = (png: Buffer): { width: number; height: number } | null => {
  if (png.length < 24 || !png.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
};

const parseThumbMeta = (text: string): ThumbMeta | null => {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) return null;
    const record = value as Record<string, unknown>;
    if (typeof record.key !== 'string' || typeof record.createdAt !== 'string' || typeof record.viewport !== 'string') return null;
    if (record.scheme !== THUMB_SCHEME) return null;
    return { key: record.key, createdAt: record.createdAt, viewport: record.viewport, scheme: record.scheme };
  } catch {
    return null;
  }
};

/** The file to capture: the artifact entry, or the first screen with a file (SPEC §9.5). */
const captureSourceOf = (record: DesignRecord): string | null => {
  if (record.design.kind === 'artifact') {
    return record.files.entry?.exists ? ENTRY_FILE : null;
  }
  for (const screen of record.design.screens) {
    if (record.files.screens[screen.id]?.exists) return screenFileOf(screen.id);
  }
  return null;
};

const viewportOf = (record: DesignRecord): Viewport => record.design.viewports[0] ?? { ...VIEWPORT_LAPTOP };

export const createThumbnailService = (deps: ThumbnailDeps): ThumbnailServiceFull => {
  const { store, settings, hub, log, renders } = deps;
  const resolveBrowser = deps.resolveBrowser ?? (() => detectBrowser(settings.read()));
  const tmp = deps.tmpdir ?? (() => os.tmpdir());
  const platform = deps.platform ?? process.platform;
  const isRoot = deps.isRoot ?? (() => process.getuid?.() === 0);

  // Browser probe cache (peek is synchronous and runs per list row).
  let browserCache: { at: number; resolution: BrowserResolution } | null = null;
  const browser = (): BrowserResolution => {
    const now = Date.now();
    if (browserCache && now - browserCache.at < 30_000) return browserCache.resolution;
    const resolution = resolveBrowser();
    browserCache = { at: now, resolution };
    return resolution;
  };

  type MemoryState = { state: ThumbState; key: string | null; message?: string; width?: number; height?: number };
  const memory = new Map<string, MemoryState>();

  // Queue: newest-first, deduped by slug, one job at a time.
  const queue: string[] = [];
  const queued = new Set<string>();
  let running: string | null = null;
  let runningChild: ChildProcess | null = null;
  let disposed = false;

  const kick = (): void => {
    if (disposed || running !== null) return;
    const slug = queue.shift();
    if (slug === undefined) return;
    queued.delete(slug);
    running = slug;
    runJob(slug)
      .catch((error: unknown) => log.warn('thumbnail.job-failed', { slug, error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        running = null;
        kick();
      });
  };

  const schedule = (slug: string): void => {
    if (disposed || queued.has(slug) || running === slug) return;
    queued.add(slug);
    queue.unshift(slug); // newest first
    kick();
  };

  /** The render key of a design's default view; null with a memory state when it cannot render. */
  const renderKeyOf = async (slug: string): Promise<string | null> => {
    try {
      const meta = await renders.render(slug, {});
      return meta.key;
    } catch (error) {
      if (error instanceof ApiError && error.code === 'no-html') {
        memory.set(slug, { state: 'unavailable', key: null, message: 'There is no HTML to capture yet.' });
        return null;
      }
      if (error instanceof ApiError && error.code === 'too-large') {
        memory.set(slug, { state: 'failed', key: null, message: 'This design is too large for a thumbnail.' });
        return null;
      }
      throw error;
    }
  };

  const readMeta = async (designDir: string): Promise<ThumbMeta | null> => {
    const text = await readFile(path.join(designDir, THUMB_META_FILE), 'utf8').catch(() => null);
    return text === null ? null : parseThumbMeta(text);
  };

  const readyResponse = async (slug: string, designDir: string, key: string): Promise<ThumbnailResponse | null> => {
    const meta = await readMeta(designDir);
    if (meta?.key !== key) return null;
    const png = await readFile(path.join(designDir, THUMB_FILE)).catch(() => null);
    if (png === null) return null;
    const size = pngSize(png);
    if (size === null) return null;
    memory.set(slug, { state: 'ready', key, ...size });
    return { state: 'ready', key, png: png.toString('base64'), width: size.width, height: size.height };
  };

  const capture = async (slug: string, record: DesignRecord, key: string): Promise<void> => {
    const browserPath = browser().path;
    if (browserPath === null) {
      memory.set(slug, { state: 'unavailable', key: null, message: 'No Chrome, Edge or Chromium browser was found; the list shows live previews instead.' });
      return;
    }
    const sourceRel = captureSourceOf(record);
    if (sourceRel === null) {
      memory.set(slug, { state: 'unavailable', key, message: 'There is no HTML to capture yet.' });
      return;
    }
    const viewport = viewportOf(record);
    const scale = THUMB_WIDTH / viewport.width;
    const workParent = thumbWorkParent(platform, record.path, tmp());
    let work: string;
    try {
      if (workParent !== tmp()) {
        await mkdir(workParent, { recursive: true });
        await removeStaleWorkDirs(workParent);
      }
      work = await mkdtemp(path.join(workParent, WORK_PREFIX));
    } catch (error) {
      log.warn('thumbnail.workdir-failed', { slug, error: error instanceof Error ? error.message : String(error) });
      memory.set(slug, { state: 'failed', key, message: 'Design Chamber could not create a work folder for the thumbnail.' });
      hub.emit({ slug, kind: 'thumb' });
      return;
    }
    const out = path.join(work, 'thumb.png');
    const args = captureArgs({
      workDir: work,
      out,
      viewport,
      scale,
      url: pathToFileURL(path.join(record.path, ...sourceRel.split('/'))).href,
      platform,
      isRoot: isRoot(),
    });
    try {
      const result = await new Promise<{ code: number | null; timedOut: boolean }>((resolve) => {
        const child = spawn(browserPath, args, { stdio: 'ignore' });
        runningChild = child;
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill();
        }, THUMB_TIMEOUT_MS);
        child.on('error', (error) => {
          clearTimeout(timer);
          runningChild = null;
          log.warn('thumbnail.spawn-failed', { slug, error: error.message });
          resolve({ code: null, timedOut });
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          runningChild = null;
          resolve({ code, timedOut });
        });
      });

      const png = await readFile(out).catch(() => null);
      const size = png === null ? null : pngSize(png);
      if (png === null || size === null) {
        memory.set(slug, {
          state: 'failed',
          key,
          message: result.timedOut
            ? 'The browser took too long to render this thumbnail.'
            : `The browser did not produce a thumbnail (exit ${result.code === null ? 'error' : result.code}).`,
        });
        hub.emit({ slug, kind: 'thumb' });
        return;
      }

      // Atomic publish: a tmp file in the design folder (untracked `.thumb.` prefix), then rename.
      const tmpPng = path.join(record.path, `.thumb.${Date.now()}.png`);
      await writeFile(tmpPng, png);
      await rename(tmpPng, path.join(record.path, THUMB_FILE));
      await mkdir(path.join(record.path, '.chamber'), { recursive: true });
      const meta: ThumbMeta = { key, createdAt: new Date().toISOString(), viewport: viewport.id, scheme: THUMB_SCHEME };
      await writeFile(path.join(record.path, THUMB_META_FILE), `${JSON.stringify(meta, null, 2)}\n`);
      memory.set(slug, { state: 'ready', key, ...size });
      hub.emit({ slug, kind: 'thumb' });
    } finally {
      await rm(work, { recursive: true, force: true }).catch(() => undefined);
    }
  };

  const runJob = async (slug: string): Promise<void> => {
    const record = await store.get(slug).catch(() => null);
    if (record === null) {
      memory.delete(slug);
      return;
    }
    if (!browser().path) {
      memory.set(slug, { state: 'unavailable', key: null, message: 'No Chrome, Edge or Chromium browser was found; the list shows live previews instead.' });
      return;
    }
    const key = await renderKeyOf(slug);
    if (key === null) {
      hub.emit({ slug, kind: 'thumb' });
      return;
    }
    const fresh = await readyResponse(slug, record.path, key);
    if (fresh !== null) {
      hub.emit({ slug, kind: 'thumb' });
      return;
    }
    await capture(slug, record, key);
  };

  // Content events re-run the capture, debounced (§9.5).
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const unsubscribe = hub.subscribe((event) => {
    if (event.kind === 'root') {
      for (const timer of debounceTimers.values()) clearTimeout(timer);
      debounceTimers.clear();
      memory.clear();
      browserCache = null;
      return;
    }
    if (event.slug === null) return;
    const slug = event.slug;
    if (event.kind === 'removed') {
      const timer = debounceTimers.get(slug);
      if (timer) clearTimeout(timer);
      debounceTimers.delete(slug);
      memory.delete(slug);
      return;
    }
    if (event.kind !== 'files' && event.kind !== 'design' && event.kind !== 'added') return;
    const existing = debounceTimers.get(slug);
    if (existing) clearTimeout(existing);
    debounceTimers.set(
      slug,
      setTimeout(() => {
        debounceTimers.delete(slug);
        schedule(slug);
      }, THUMB_DEBOUNCE_MS),
    );
  });

  deps.onDispose(() => {
    disposed = true;
    unsubscribe();
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    queue.length = 0;
    queued.clear();
    runningChild?.kill();
  });

  const service: ThumbnailServiceFull = {
    __dcThumbnailService: true,

    peek(slug: string): { state: ThumbState; key: string | null } {
      const known = memory.get(slug);
      if (known) return { state: known.state, key: known.key };
      if (!SLUG_PATTERN.test(slug)) return { state: 'unavailable', key: null };
      const designDir = path.join(settings.root(), slug);
      try {
        const text = readFileSync(path.join(designDir, THUMB_META_FILE), 'utf8');
        const meta = parseThumbMeta(text);
        if (meta && existsSync(path.join(designDir, THUMB_FILE))) {
          memory.set(slug, { state: 'ready', key: meta.key });
          return { state: 'ready', key: meta.key };
        }
      } catch {
        // No thumbnail on disk — fall through to the browser probe.
      }
      if (!browser().path) return { state: 'unavailable', key: null };
      // A browser exists but nothing is captured yet: the GET route (or the next content
      // event) enqueues; the UI shows a spinner meanwhile.
      return { state: 'pending', key: null };
    },

    async get(slug: string): Promise<ThumbnailResponse> {
      const record = await store.get(slug);
      if (!browser().path) {
        return { state: 'unavailable', key: null, message: 'No Chrome, Edge or Chromium browser was found; the list shows live previews instead.' };
      }
      const key = await renderKeyOf(slug);
      if (key === null) {
        const known = memory.get(slug);
        return { state: known?.state ?? 'unavailable', key: null, message: known?.message };
      }
      const ready = await readyResponse(slug, record.path, key);
      if (ready) return ready;
      const known = memory.get(slug);
      if (known && known.state === 'failed' && known.key === key) {
        // Same content already failed once: report it, retry only on an explicit refresh.
        return { state: 'failed', key, message: known.message };
      }
      schedule(slug);
      return { state: 'pending', key };
    },

    async refresh(slug: string): Promise<ThumbnailRefreshResponse> {
      await store.get(slug); // 404/bad-slug before anything else
      browserCache = null; // a refresh re-probes: the user may just have installed a browser
      if (!browser().path) {
        return { state: 'unavailable' };
      }
      const key = await renderKeyOf(slug);
      if (key === null) return { state: memory.get(slug)?.state ?? 'unavailable' };
      schedule(slug);
      return { state: 'pending' };
    },
  };
  return service;
};

// ---- wiring (routes and main.ts share one instance per context) ----

const instances = new WeakMap<ServiceContext, ThumbnailServiceFull>();

const isReal = (candidate: ThumbnailService): candidate is ThumbnailServiceFull =>
  (candidate as { __dcThumbnailService?: unknown }).__dcThumbnailService === true;

export const ensureThumbnailService = (ctx: ServiceContext): ThumbnailServiceFull => {
  if (isReal(ctx.thumbnails)) return ctx.thumbnails;
  const existing = instances.get(ctx);
  if (existing) return existing;
  const created = createThumbnailService({
    store: ctx.store,
    settings: ctx.settings,
    hub: ctx.hub,
    log: ctx.log,
    onDispose: ctx.onDispose,
    renders: ensureRenderService(ctx),
  });
  instances.set(ctx, created);
  return created;
};
