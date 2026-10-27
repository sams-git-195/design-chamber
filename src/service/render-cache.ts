// The render service and its cache (docs/SPEC.md §4.1, §7, §9.5).
//
// GET /render answers metadata + a chunk count; GET /render/chunk answers raw text chunks of
// ≤ RENDER_CHUNK_MAX_BYTES UTF-8 bytes, because one host answer is capped at 8 MB (F8). The
// guest concatenates the chunks back to the exact document.
//
// Cache key = sha256(entry path + version id + each input's size+mtime or the version tree
// hash). Live entries are validated by re-statting their inputs (cheap) and are dropped on
// hub change events; version entries are immutable. LRU over RENDER_CACHE_MAX_BYTES.

import { createHash } from 'node:crypto';

import { ENTRY_FILE, parseDesignJsonText, screenFileOf } from '../shared/design-json.ts';
import {
  BRIDGE_TITLE_MAX,
  RENDER_CACHE_MAX_BYTES,
  RENDER_CHUNK_MAX_BYTES,
  SCREEN_ID_PATTERN,
  VERSION_ID_PATTERN,
} from '../shared/limits.ts';
import type { RenderMeta, RenderQuery } from '../shared/api.ts';
import type { DesignFiles, DesignJson, VersionEntry } from '../shared/types.ts';
import {
  BundleMissingEntry,
  BundleTooLarge,
  bundleDocument,
  createLiveFileSource,
  type BundleInput,
  type BundleResult,
  type FileSource,
} from './bundle.ts';
import type { ChangeHub, DesignRecord, DesignStore, RenderService, ServiceContext } from './context.ts';
import { ApiError } from './http.ts';
import { ensureVersionsService, type VersionsService } from './versions.ts';

/**
 * Split a document into raw-text chunks of ≤ maxBytes UTF-8 bytes, never splitting a
 * surrogate pair (a lone surrogate is not valid UTF-8, so the host's text answer would not
 * round-trip). Requires maxBytes ≥ 4 — one UTF-8 character is at most 4 bytes.
 */
export const splitChunks = (html: string, maxBytes: number = RENDER_CHUNK_MAX_BYTES): string[] => {
  if (maxBytes < 4) throw new Error('splitChunks: maxBytes must be at least 4.');
  const chunks: string[] = [];
  let start = 0;
  while (start < html.length) {
    // Smallest legal chunk: one character — or a whole surrogate pair when one starts here.
    const first = html.charCodeAt(start);
    const floor = first >= 0xd800 && first <= 0xdbff ? start + 2 : start + 1;
    let end = Math.min(html.length, start + maxBytes);
    let slice = html.slice(start, end);
    let bytes = Buffer.byteLength(slice, 'utf8');
    // Cutting e characters removes ≥ e bytes; never shrink below `floor`, so every iteration
    // makes progress and the loop terminates.
    while (bytes > maxBytes) {
      end = Math.max(floor, end - (bytes - maxBytes));
      slice = html.slice(start, end);
      bytes = Buffer.byteLength(slice, 'utf8');
      if (end === floor) break;
    }
    // Never end a chunk on a high surrogate whose pair falls into the next one.
    const lastCode = slice.charCodeAt(slice.length - 1);
    if (end < html.length && lastCode >= 0xd800 && lastCode <= 0xdbff) {
      end -= 1;
      slice = html.slice(start, end);
    }
    chunks.push(slice);
    start = end;
  }
  return chunks;
};

const decodeEntities = (text: string): string =>
  text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

/** The document `<title>`, entity-decoded and capped (empty when there is none). */
export const extractTitle = (html: string): string => {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match) return '';
  return decodeEntities((match[1] ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()).slice(0, BRIDGE_TITLE_MAX);
};

/** The entry file a render/export shows: the artifact entry, or the (default: first existing) screen. */
export const resolveEntryFile = (
  design: DesignJson,
  files: DesignFiles,
  screen: string | undefined,
): { entryRel: string; screenId: string | null } => {
  if (design.kind === 'artifact') {
    if (screen !== undefined) throw new ApiError('not-found', 'This artifact is a single page; it has no screens.');
    return { entryRel: ENTRY_FILE, screenId: null };
  }
  if (screen !== undefined) {
    if (!SCREEN_ID_PATTERN.test(screen)) throw new ApiError('bad-request', 'That is not a screen id.');
    if (!design.screens.some((candidate) => candidate.id === screen)) {
      throw new ApiError('not-found', `This canvas has no screen "${screen}".`);
    }
    return { entryRel: screenFileOf(screen), screenId: screen };
  }
  const existing = design.screens.find((candidate) => files.screens[candidate.id]?.exists);
  const pick = existing ?? design.screens[0];
  if (!pick) throw new ApiError('no-html', 'This canvas has no screens yet — the agent has not written one.');
  return { entryRel: screenFileOf(pick.id), screenId: pick.id };
};

const sha256Text = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

const keyOf = (parts: { slug: string; entryRel: string; version: string | null; inputs: readonly BundleInput[]; treeHash?: string }): string =>
  sha256Text(
    JSON.stringify({
      slug: parts.slug,
      entry: parts.entryRel,
      version: parts.version,
      tree: parts.treeHash ?? null,
      inputs: [...parts.inputs].sort((a, b) => (a.rel < b.rel ? -1 : 1)).map((input) => [input.rel, input.size, input.mtimeMs]),
    }),
  );

type CacheEntry = {
  key: string;
  bytes: number;
  chunks: string[];
  meta: RenderMeta;
  version: string | null;
  entryRel: string;
  inputs: BundleInput[];
};

export type BrandedRenderService = RenderService & { __dcRenderService?: true };

export type RenderDeps = {
  store: DesignStore;
  hub: ChangeHub;
  onDispose: (fn: () => void | Promise<void>) => void;
  versions: VersionsService;
};

export const createRenderService = (deps: RenderDeps): BrandedRenderService => {
  const { store, hub, versions } = deps;
  const cache = new Map<string, CacheEntry>(); // insertion order = LRU order
  const byKey = new Map<string, string>();
  let totalBytes = 0;

  const cacheIdOf = (slug: string, version: string | null, entryRel: string): string => `${slug}\u0000${version ?? ''}\u0000${entryRel}`;

  const drop = (cacheId: string): void => {
    const entry = cache.get(cacheId);
    if (!entry) return;
    cache.delete(cacheId);
    if (byKey.get(entry.key) === cacheId) byKey.delete(entry.key);
    totalBytes -= entry.bytes;
  };

  const put = (cacheId: string, entry: CacheEntry): void => {
    drop(cacheId);
    cache.set(cacheId, entry);
    byKey.set(entry.key, cacheId);
    totalBytes += entry.bytes;
    // Oldest first (Map insertion order); a single entry never exceeds the cap (60 MB < 256 MB).
    for (const oldId of [...cache.keys()]) {
      if (totalBytes <= RENDER_CACHE_MAX_BYTES) break;
      drop(oldId);
    }
  };

  const evictSlug = (slug: string): void => {
    for (const cacheId of [...cache.keys()]) {
      if (cacheId.startsWith(`${slug}\u0000`)) drop(cacheId);
    }
  };

  const unsubscribe = hub.subscribe((event) => {
    if (event.kind === 'root') {
      for (const cacheId of [...cache.keys()]) drop(cacheId);
      return;
    }
    if (event.slug === null) return;
    if (event.kind === 'files' || event.kind === 'design' || event.kind === 'added' || event.kind === 'removed') evictSlug(event.slug);
  });
  deps.onDispose(unsubscribe);

  /** Stat the inputs of a cached live render; when all still match, the cache entry is valid. */
  const validateLive = async (entry: CacheEntry, source: FileSource): Promise<boolean> => {
    if (!source.stat) return false;
    for (const input of entry.inputs) {
      const info = await source.stat(input.rel);
      if (info === null || info.size !== input.size || info.mtimeMs !== input.mtimeMs) return false;
    }
    return true;
  };

  const service: BrandedRenderService = {
    __dcRenderService: true,

    async render(slug: string, query: RenderQuery): Promise<RenderMeta> {
      const record: DesignRecord = await store.get(slug);
      const version = query.version;
      if (version !== undefined && !VERSION_ID_PATTERN.test(version)) throw new ApiError('bad-request', 'That is not a version id.');

      let source: FileSource;
      let design = record.design;
      let files = record.files;
      let versionEntry: VersionEntry | null = null;
      if (version !== undefined) {
        const tree = await versions.readTree(slug, version); // 404 when unknown
        versionEntry = tree.entry;
        source = tree.source;
        const stored = await source.read('design.json').catch(() => null);
        if (stored) {
          const parsed = parseDesignJsonText(stored.bytes.toString('utf8'), {
            kind: record.design.kind,
            fallbackTitle: record.design.title,
            fallbackTime: record.design.created,
          });
          design = { ...record.design, ...parsed.design };
          const versionFiles: DesignFiles = { screens: {} };
          if (design.kind === 'artifact') {
            versionFiles.entry = { exists: versionEntry.files[ENTRY_FILE] !== undefined, size: 0, mtime: null };
          }
          for (const screen of design.screens) {
            versionFiles.screens[screen.id] = { exists: versionEntry.files[screenFileOf(screen.id)] !== undefined, size: 0, mtime: null };
          }
          files = versionFiles;
        }
      } else {
        source = createLiveFileSource(record.path);
      }

      const { entryRel } = resolveEntryFile(design, files, query.screen);
      const cacheId = cacheIdOf(slug, version ?? null, entryRel);
      const cached = cache.get(cacheId);
      if (cached) {
        // Move to the newest end of the LRU on every hit.
        cache.delete(cacheId);
        cache.set(cacheId, cached);
        if (cached.version !== null || (await validateLive(cached, source))) return cached.meta;
        drop(cacheId);
      }

      let result: BundleResult;
      try {
        result = await bundleDocument(source, entryRel, { mode: 'render' });
      } catch (error) {
        if (error instanceof BundleMissingEntry) {
          throw new ApiError('no-html', `The document for this view (${entryRel}) has not been written yet.`);
        }
        if (error instanceof BundleTooLarge) {
          throw new ApiError('too-large', 'This design is too large to render inside OpenChamber. Ask the agent to use smaller assets.');
        }
        throw error;
      }

      const bytes = Buffer.byteLength(result.html, 'utf8');
      const key = keyOf({
        slug,
        entryRel,
        version: version ?? null,
        inputs: result.inputs,
        ...(versionEntry ? { treeHash: versionEntry.treeHash } : {}),
      });
      const chunks = splitChunks(result.html);
      const meta: RenderMeta = {
        key,
        chunks: chunks.length,
        bytes,
        title: extractTitle(result.html),
        missing: result.missing,
        blocked: result.blocked,
        external: result.external,
        warnings: result.warnings,
      };
      put(cacheId, { key, bytes, chunks, meta, version: version ?? null, entryRel, inputs: result.inputs });
      return meta;
    },

    chunk(key: string, n: number): string {
      const cacheId = byKey.get(key);
      const entry = cacheId === undefined ? undefined : cache.get(cacheId);
      if (!entry) throw new ApiError('stale', 'That render is no longer in the cache; load the design again.');
      if (!Number.isInteger(n) || n < 0 || n >= entry.chunks.length) {
        throw new ApiError('bad-request', 'That chunk number is not part of this render.');
      }
      const chunk = entry.chunks[n];
      if (chunk === undefined) throw new ApiError('stale', 'That render is no longer in the cache; load the design again.');
      return chunk;
    },
  };

  return service;
};

// ---- wiring (routes and main.ts share one instance per context) ----

const instances = new WeakMap<ServiceContext, BrandedRenderService>();

const isReal = (candidate: RenderService): candidate is BrandedRenderService =>
  (candidate as { __dcRenderService?: unknown }).__dcRenderService === true;

export const ensureRenderService = (ctx: ServiceContext): BrandedRenderService => {
  if (isReal(ctx.renders)) return ctx.renders;
  const existing = instances.get(ctx);
  if (existing) return existing;
  const created = createRenderService({
    store: ctx.store,
    hub: ctx.hub,
    onDispose: ctx.onDispose,
    versions: ensureVersionsService(ctx),
  });
  instances.set(ctx, created);
  return created;
};
