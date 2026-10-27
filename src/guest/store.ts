// App state for the panel and page (docs/SPEC.md §8.2): designs list, the open design,
// versions, settings, presets, thumbnails, service status, and per-source render revisions.
// The UI reads only through `getState()` / `subscribe()` and acts through the methods here.
//
// Loads put their outcome in state (`Loadable`: idle → loading → ready | error). Mutations
// resolve with the service answer or reject with a `ServiceError` whose `message` the UI shows
// next to the control; on success they update state at once and the change feed confirms.

import type {
  CreateCommentBody,
  DesignDetailResponse,
  DesignListResponse,
  DesignsQuery,
  ExportBody,
  ExportResponse,
  PatchCommentBody,
  PatchDesignBody,
  PresetsResponse,
  PutSettingsBody,
  RestoreVersionResponse,
  SettingsResponse,
  SourceResponse,
  ThumbnailResponse,
  VersionDiffResponse,
  VersionListResponse,
} from '../shared/api.ts';
import type { Comment, DesignJson, VersionSummary } from '../shared/types.ts';
import type { ChangeBatch, ChangeFeed } from './changes.ts';
import { toServiceError, type RenderDoc, type ServiceClient, type ServiceError } from './service-client.ts';

export type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/** `data` keeps the last good value while a reload runs or after a failed reload. */
export type Loadable<T> = { status: LoadStatus; data: T | null; error: ServiceError | null };

export type ServiceStatus = { state: 'unknown' | 'ready' | 'error'; version: string | null; error: ServiceError | null };

export type AppState = {
  service: ServiceStatus;
  settings: Loadable<SettingsResponse>;
  designs: Loadable<DesignListResponse>;
  presets: Loadable<PresetsResponse>;
  /** The design shown in the viewer / wall; null on the list. */
  open: (Loadable<DesignDetailResponse> & { slug: string }) | null;
  /** Versions of the open design, once asked for. */
  versions: (Loadable<VersionListResponse> & { slug: string }) | null;
  /** Latest thumbnail answer per slug. */
  thumbs: Record<string, ThumbnailResponse>;
  /**
   * Render revision per source (`renderSourceKey(slug, screen)`). Bumped when that source's
   * files change; an artboard reloads its document when its revision moves.
   */
  renderRevs: Record<string, number>;
};

export const renderSourceKey = (slug: string, screen: string | null): string => `${slug}|${screen ?? ''}`;

const idle = <T>(): Loadable<T> => ({ status: 'idle', data: null, error: null });

export const initialState = (): AppState => ({
  service: { state: 'unknown', version: null, error: null },
  settings: idle(),
  designs: idle(),
  presets: idle(),
  open: null,
  versions: null,
  thumbs: {},
  renderRevs: {},
});

/**
 * Which render sources a `files` event touches (§13.2 live refresh): `screens/<id>.html` → that
 * screen; `design.json` → none (layout comes from the detail refresh); anything else
 * (`tokens.css`, `assets/**`, `DESIGN.md`, `index.html`, unknown) → every source of the design.
 */
export const affectedSources = (design: Pick<DesignJson, 'kind' | 'screens'>, files: readonly string[]): 'all' | (string | null)[] => {
  const screens = new Set<string | null>();
  for (const file of files) {
    if (file === 'design.json') continue;
    if (design.kind === 'canvas') {
      const screen = design.screens.find((entry) => entry.file === file);
      if (screen) {
        screens.add(screen.id);
        continue;
      }
    }
    return 'all';
  }
  return [...screens];
};

export type Store = {
  getState(): AppState;
  /** Called after every state change with the new and previous state. */
  subscribe(listener: (state: AppState, previous: AppState) => void): () => void;

  checkHealth(): Promise<void>;
  loadSettings(): Promise<void>;
  updateSettings(body: PutSettingsBody): Promise<SettingsResponse>;
  loadPresets(): Promise<void>;
  refreshDesigns(query?: DesignsQuery): Promise<void>;

  openDesign(slug: string): Promise<void>;
  closeDesign(): void;
  refreshOpenDesign(): Promise<void>;
  renameDesign(slug: string, title: string): Promise<DesignJson>;
  patchDesign(slug: string, body: PatchDesignBody): Promise<DesignJson>;
  deleteDesign(slug: string): Promise<string>;

  addComment(slug: string, body: CreateCommentBody): Promise<Comment>;
  updateComment(slug: string, id: string, patch: PatchCommentBody): Promise<Comment>;
  deleteComment(slug: string, id: string): Promise<void>;

  loadVersions(slug: string): Promise<void>;
  snapshotVersion(slug: string, label?: string): Promise<VersionSummary | null>;
  restoreVersion(slug: string, versionId: string): Promise<RestoreVersionResponse>;
  diffVersion(slug: string, versionId: string, against?: string): Promise<VersionDiffResponse>;

  loadRender(slug: string, screen: string | null, version?: string | null): Promise<RenderDoc>;
  loadThumbnail(slug: string): Promise<ThumbnailResponse | null>;
  loadSource(slug: string, screen?: string | null): Promise<SourceResponse>;
  exportDesign(slug: string, body: ExportBody): Promise<ExportResponse>;
  reveal(path: string): Promise<void>;

  /** Apply one change-feed batch (exposed for tests; `connect` wires it). */
  applyChanges(batch: ChangeBatch): Promise<void>;
  /** Subscribe to a change feed and start it; returns the disconnect function. */
  connect(feed: ChangeFeed): () => void;
};

export type StoreDeps = { client: ServiceClient };

export const createStore = ({ client }: StoreDeps): Store => {
  let state = initialState();
  let lastQuery: DesignsQuery = {};
  const listeners = new Set<(state: AppState, previous: AppState) => void>();

  const set = (patch: Partial<AppState>): void => {
    const previous = state;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state, previous);
  };

  /** Runs a load into one Loadable slot; `read` re-reads the slot so an answer overtaken by a newer load is dropped. */
  const load = async <T>(
    read: () => Loadable<T> | null,
    write: (slot: Loadable<T>) => void,
    request: () => Promise<T>,
  ): Promise<void> => {
    const before = read();
    write({ status: 'loading', data: before?.data ?? null, error: null });
    const ticket = read();
    try {
      const data = await request();
      if (read() !== ticket) return;
      write({ status: 'ready', data, error: null });
    } catch (error) {
      if (read() !== ticket) return;
      write({ status: 'error', data: before?.data ?? null, error: toServiceError(error) });
    }
  };

  const mutate = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw toServiceError(error);
    }
  };

  const bumpRevs = (slug: string, sources: (string | null)[]): void => {
    const renderRevs = { ...state.renderRevs };
    for (const source of sources) {
      const key = renderSourceKey(slug, source);
      renderRevs[key] = (renderRevs[key] ?? 0) + 1;
    }
    set({ renderRevs });
  };

  /** Every source of a design: the artifact (null) or each screen. */
  const sourcesOf = (design: DesignJson): (string | null)[] =>
    design.kind === 'artifact' ? [null] : design.screens.map((screen) => screen.id);

  const replaceComment = (slug: string, comment: Comment): void => {
    const open = state.open;
    if (!open || open.slug !== slug || !open.data) return;
    const comments = open.data.design.comments.some((entry) => entry.id === comment.id)
      ? open.data.design.comments.map((entry) => (entry.id === comment.id ? comment : entry))
      : [...open.data.design.comments, comment];
    set({ open: { ...open, data: { ...open.data, design: { ...open.data.design, comments } } } });
  };

  const store: Store = {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    checkHealth: async () => {
      try {
        const health = await client.call('GET /health');
        set({ service: { state: 'ready', version: health.version, error: null } });
      } catch (error) {
        set({ service: { state: 'error', version: null, error: toServiceError(error) } });
      }
    },

    loadSettings: () =>
      load(
        () => state.settings,
        (settings) => set({ settings }),
        () => client.call('GET /settings'),
      ),

    updateSettings: (body) =>
      mutate(async () => {
        const settings = await client.call('PUT /settings', { body });
        set({ settings: { status: 'ready', data: settings, error: null } });
        return settings;
      }),

    loadPresets: () =>
      load(
        () => state.presets,
        (presets) => set({ presets }),
        () => client.call('GET /presets'),
      ),

    refreshDesigns: (query) => {
      if (query) lastQuery = query;
      const current: DesignsQuery = {};
      if (lastQuery.q) current.q = lastQuery.q;
      if (lastQuery.kind) current.kind = lastQuery.kind;
      return load(
        () => state.designs,
        (designs) => set({ designs }),
        () => client.call('GET /designs', { query: current }),
      );
    },

    openDesign: async (slug) => {
      const keep = state.open?.slug === slug ? state.open.data : null;
      set({ open: { slug, status: 'loading', data: keep, error: null }, versions: state.versions?.slug === slug ? state.versions : null });
      await store.refreshOpenDesign();
    },

    closeDesign: () => set({ open: null, versions: null }),

    refreshOpenDesign: async () => {
      const open = state.open;
      if (!open) return;
      const slug = open.slug;
      await load(
        () => (state.open?.slug === slug ? state.open : null),
        (slot) => {
          if (state.open?.slug === slug) set({ open: { ...slot, slug } });
        },
        () => client.call('GET /designs/:slug', { params: { slug } }),
      );
    },

    renameDesign: (slug, title) => store.patchDesign(slug, { title }),

    patchDesign: (slug, body) =>
      mutate(async () => {
        const { design } = await client.call('PATCH /designs/:slug', { params: { slug }, body });
        const open = state.open;
        if (open?.slug === slug && open.data) set({ open: { ...open, data: { ...open.data, design } } });
        const list = state.designs.data;
        if (list) {
          const designs = list.designs.map((entry) =>
            entry.slug === slug ? { ...entry, title: design.title, sessionId: design.sessionId, updated: design.updated } : entry,
          );
          set({ designs: { ...state.designs, data: { ...list, designs } } });
        }
        return design;
      }),

    deleteDesign: (slug) =>
      mutate(async () => {
        const { trashedTo } = await client.call('DELETE /designs/:slug', { params: { slug } });
        const list = state.designs.data;
        if (list) set({ designs: { ...state.designs, data: { ...list, designs: list.designs.filter((entry) => entry.slug !== slug) } } });
        if (state.open?.slug === slug) set({ open: null, versions: null });
        return trashedTo;
      }),

    addComment: (slug, body) =>
      mutate(async () => {
        const { comment } = await client.call('POST /designs/:slug/comments', { params: { slug }, body });
        replaceComment(slug, comment);
        return comment;
      }),

    updateComment: (slug, id, patch) =>
      mutate(async () => {
        const { comment } = await client.call('PATCH /designs/:slug/comments/:id', { params: { slug, id }, body: patch });
        replaceComment(slug, comment);
        return comment;
      }),

    deleteComment: (slug, id) =>
      mutate(async () => {
        await client.call('DELETE /designs/:slug/comments/:id', { params: { slug, id } });
        const open = state.open;
        if (open?.slug === slug && open.data) {
          const comments = open.data.design.comments.filter((entry) => entry.id !== id);
          set({ open: { ...open, data: { ...open.data, design: { ...open.data.design, comments } } } });
        }
      }),

    loadVersions: async (slug) => {
      if (state.versions?.slug !== slug) set({ versions: { slug, status: 'idle', data: null, error: null } });
      await load(
        () => (state.versions?.slug === slug ? state.versions : null),
        (slot) => {
          if (state.versions?.slug === slug) set({ versions: { ...slot, slug } });
        },
        () => client.call('GET /designs/:slug/versions', { params: { slug } }),
      );
    },

    snapshotVersion: (slug, label) =>
      mutate(async () => {
        const body: { reason: 'manual'; label?: string } = { reason: 'manual' };
        if (label) body.label = label;
        const { created } = await client.call('POST /designs/:slug/versions', { params: { slug }, body });
        if (state.versions?.slug === slug) void store.loadVersions(slug);
        return created;
      }),

    restoreVersion: (slug, versionId) =>
      mutate(async () => {
        const answer = await client.call('POST /designs/:slug/versions/:vid/restore', { params: { slug, vid: versionId } });
        if (state.versions?.slug === slug) void store.loadVersions(slug);
        if (state.open?.slug === slug && state.open.data) bumpRevs(slug, sourcesOf(state.open.data.design));
        return answer;
      }),

    diffVersion: (slug, versionId, against) =>
      mutate(() =>
        client.call('GET /designs/:slug/versions/:vid/diff', { params: { slug, vid: versionId }, query: against ? { against } : {} }),
      ),

    loadRender: (slug, screen, version = null) => mutate(() => client.loadRender(slug, screen, version)),

    loadThumbnail: async (slug) => {
      const summary = state.designs.data?.designs.find((entry) => entry.slug === slug);
      try {
        const thumb = await client.thumbnail(slug, summary?.thumb.key ?? null);
        set({ thumbs: { ...state.thumbs, [slug]: thumb } });
        return thumb;
      } catch {
        // A missing thumbnail falls back to the live mini-frame (§4.4); nothing to report.
        return null;
      }
    },

    loadSource: (slug, screen = null) =>
      mutate(() => client.call('GET /designs/:slug/source', { params: { slug }, query: screen ? { screen } : {} })),

    exportDesign: (slug, body) => mutate(() => client.call('POST /designs/:slug/export', { params: { slug }, body })),

    reveal: (path) =>
      mutate(async () => {
        await client.call('POST /reveal', { body: { path } });
      }),

    applyChanges: async (batch) => {
      const tasks: Promise<unknown>[] = [];
      const openSlug = state.open?.slug ?? null;
      const openDesign = state.open?.data?.design ?? null;

      if (batch.reset) {
        tasks.push(store.refreshDesigns(), store.loadSettings());
        if (openSlug) {
          tasks.push(store.refreshOpenDesign());
          if (openDesign) bumpRevs(openSlug, sourcesOf(openDesign));
        }
        if (state.versions) tasks.push(store.loadVersions(state.versions.slug));
        await Promise.all(tasks);
        return;
      }

      let list = false;
      let detail = false;
      /** The open design was (re)created: every artboard reloads once its new detail is in. */
      let recreated = false;
      let versions = false;
      let settings = false;
      const thumbs = new Set<string>();
      const revs = new Map<string, Set<string | null> | 'all'>();

      for (const event of batch.events) {
        switch (event.kind) {
          case 'root':
            settings = true;
            list = true;
            break;
          case 'added':
            // Files written right after the folder appeared come as `added` alone (the service
            // coalesces them), so no `files` event will name them: reload every source.
            list = true;
            if (event.slug === openSlug) {
              detail = true;
              recreated = true;
            }
            break;
          case 'removed':
          case 'design':
            list = true;
            if (event.slug === openSlug) detail = true;
            break;
          case 'comments':
            list = true;
            if (event.slug === openSlug) detail = true;
            break;
          case 'files':
            list = true;
            if (event.slug && event.slug === openSlug && openDesign) {
              detail = true;
              const touched = affectedSources(openDesign, event.files ?? []);
              const known = revs.get(event.slug);
              if (touched === 'all' || known === 'all') revs.set(event.slug, 'all');
              else revs.set(event.slug, new Set([...(known ?? []), ...touched]));
            }
            break;
          case 'thumb':
            if (event.slug) thumbs.add(event.slug);
            break;
          case 'versions':
            if (event.slug && state.versions?.slug === event.slug) versions = true;
            break;
        }
      }

      for (const [slug, touched] of revs) {
        if (!openDesign) break;
        const sources = touched === 'all' ? sourcesOf(openDesign) : [...touched];
        if (sources.length > 0) bumpRevs(slug, sources);
      }
      if (list) tasks.push(store.refreshDesigns());
      if (settings) tasks.push(store.loadSettings());
      if (detail && recreated && openSlug) {
        tasks.push(
          store.refreshOpenDesign().then(() => {
            const design = state.open?.slug === openSlug ? state.open.data?.design : null;
            if (design) bumpRevs(openSlug, sourcesOf(design));
          }),
        );
      } else if (detail) tasks.push(store.refreshOpenDesign());
      if (versions && state.versions) tasks.push(store.loadVersions(state.versions.slug));
      for (const slug of thumbs) tasks.push(store.loadThumbnail(slug));
      await Promise.all(tasks);
    },

    connect: (feed) => {
      const unsubscribe = feed.subscribe((batch) => void store.applyChanges(batch));
      feed.start();
      return () => {
        unsubscribe();
        feed.stop();
      };
    },
  };

  return store;
};
