// Visual harness only: an in-memory stand-in for the local service (docs/SPEC.md §7), typed from
// `ApiRoutes`, so the real UI and guest core can be screenshot-tested without OpenChamber.
// `fake-transport.ts` puts it behind the host's `serviceRequest`. Sample designs, comments, versions and thumbnails; every mutation emits a change event.

import type { ApiRoutes, RouteBody, RouteKey, RouteResponse, SettingsResponse } from '../../../src/shared/api.ts';
import type {
  ChangeEvent,
  Comment,
  DesignJson,
  DesignKind,
  DesignSummary,
  Screen,
  ThumbState,
  VersionSummary,
  Viewport,
} from '../../../src/shared/types.ts';
import { COFFEE, SAGE, SLATE, coffeeCheckout, coffeeHome, coffeePricing, invoiceArtifact, onboardingScreen, pricingArtifact, type Palette } from './fake-docs.ts';
import { ServiceError } from './service-error.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();

const LAPTOP: Viewport = { id: 'laptop', label: 'Laptop', width: 1280, height: 800 };
const PHONE: Viewport = { id: 'phone', label: 'Phone', width: 390, height: 844 };

type Rec = {
  design: DesignJson;
  palette: Palette;
  thumb: ThumbState;
  written: Set<string>;
  external: string[];
  blocked: string[];
  rev: number;
  versions: VersionSummary[];
  dirty: boolean;
};

const screen = (id: string, title: string): Screen => ({ id, title, file: `screens/${id}.html` });

const baseDesign = (over: Partial<DesignJson> & Pick<DesignJson, 'kind' | 'title'>): DesignJson => ({
  version: 1,
  created: ago(2 * DAY),
  updated: ago(HOUR),
  brief: '',
  sessionId: null,
  projectDirectory: 'C:\\Users\\you\\Documents\\GitHub\\ember-oak',
  preset: null,
  entry: over.kind === 'artifact' ? 'index.html' : null,
  viewports: over.kind === 'artifact' ? [LAPTOP] : [LAPTOP, PHONE],
  screens: [],
  designSystem: { confirmed: false },
  comments: [],
  ...over,
});

const comment = (id: string, over: Partial<Comment> & Pick<Comment, 'screen' | 'body'>): Comment => ({
  id,
  viewport: 'laptop',
  anchor: {
    selector: 'body > section:nth-of-type(1) > div:nth-of-type(1) > h1:nth-of-type(1)',
    text: 'Roasted this week. On your doorstep.',
    html: '<h1 style="font-size:68px;margin-bottom:22px">',
    rect: { x: 56, y: 150, w: 560, h: 150 },
    point: { x: 0.5, y: 0.35 },
  },
  status: 'open',
  created: ago(3 * HOUR),
  sentAt: null,
  sentVersion: null,
  ...over,
});

const versions = (count: number, dirty: boolean): VersionSummary[] => {
  const reasons: VersionSummary['reason'][] = ['turn', 'auto', 'turn', 'manual', 'turn', 'restore-point', 'restored'];
  const list: VersionSummary[] = [];
  for (let n = 1; n <= count; n += 1) {
    list.push({
      id: `v${n}`,
      n,
      created: ago((count - n) * 38 * MINUTE + (dirty ? 6 * MINUTE : 4 * MINUTE)),
      reason: reasons[(n - 1) % reasons.length] ?? 'auto',
      sessionId: 'ses_coffee',
      treeHash: `tree${n}`,
      bytes: 24_000 + n * 1_300,
      fileCount: 5 + n,
    });
  }
  return list;
};

const seed = (): Map<string, Rec> => {
  const map = new Map<string, Rec>();
  const put = (slug: string, rec: Omit<Rec, 'rev'>): void => void map.set(slug, { ...rec, rev: 1 });

  put('coffee-subscription', {
    design: baseDesign({
      kind: 'canvas',
      title: 'Coffee subscription',
      updated: ago(4 * MINUTE),
      sessionId: 'ses_coffee',
      brief: 'A pricing page for a coffee subscription, laptop and phone',
      screens: [screen('home', 'Home'), screen('pricing', 'Pricing'), screen('checkout', 'Checkout')],
      comments: [
        comment('c_a1', { screen: 'home', body: 'Make the headline shorter — it wraps to three lines on phone.' }),
        comment('c_a2', {
          screen: 'home',
          body: 'This button should say what happens next.',
          anchor: { selector: 'body > section:nth-of-type(1) > div:nth-of-type(1) > a:nth-of-type(1)', text: 'See the plans', html: '<a class="btn" href="pricing.html">', rect: { x: 56, y: 360, w: 150, h: 44 }, point: { x: 0.5, y: 0.5 } },
          created: ago(2 * HOUR),
        }),
        comment('c_a3', {
          screen: 'pricing',
          body: 'The middle plan needs more contrast against the page.',
          anchor: { selector: '#gone-element', text: 'Everyday · most picked', html: '<div class="card">', rect: { x: 480, y: 330, w: 320, h: 300 }, point: { x: 0.2, y: 0.1 } },
          created: ago(HOUR),
        }),
        comment('c_a4', { screen: 'home', viewport: 'phone', body: 'Looks good on phone — keep the hero image.', status: 'sent', sentAt: ago(30 * MINUTE), sentVersion: 4, created: ago(5 * HOUR), anchor: { selector: 'body > section:nth-of-type(1) > div:nth-of-type(2)', text: '☕', html: '<div style="aspect-ratio:1">', rect: { x: 20, y: 420, w: 350, h: 350 }, point: { x: 0.5, y: 0.5 } } }),
        comment('c_a5', { screen: 'checkout', body: 'Add a note about skipping months.', status: 'resolved', created: ago(DAY), anchor: { selector: 'form', text: 'Email', html: '<form class="card sans">', rect: { x: 330, y: 190, w: 620, h: 360 }, point: { x: 0.9, y: 0.05 } } }),
      ],
    }),
    palette: COFFEE,
    thumb: 'ready',
    written: new Set(['home', 'pricing', 'checkout']),
    external: [],
    blocked: [],
    versions: versions(5, false),
    dirty: false,
  });
  put('northwind-pricing', {
    design: baseDesign({
      kind: 'artifact',
      title: 'Northwind pricing page',
      updated: ago(2 * HOUR),
      created: ago(DAY),
      sessionId: 'ses_north',
      comments: [comment('c_b1', { screen: null, body: 'Highlight the Team plan with the brand colour.', anchor: { selector: 'main > div:nth-of-type(1) > div:nth-of-type(2)', text: 'Team $24', html: '<div class="card" style="border:2px solid">', rect: { x: 320, y: 330, w: 300, h: 250 }, point: { x: 0.5, y: 0.1 } } })],
    }),
    palette: SLATE,
    thumb: 'ready',
    written: new Set(['index']),
    external: ['https://cdn.tailwindcss.com'],
    blocked: [],
    versions: versions(2, true),
    dirty: true,
  });
  put('onboarding-flow', {
    design: baseDesign({
      kind: 'canvas',
      title: 'Onboarding flow',
      updated: ago(20_000),
      created: ago(20_000),
      sessionId: 'ses_onboarding',
      brief: 'A three-step onboarding for a habit tracker',
      screens: [screen('welcome', 'Welcome'), screen('profile', 'Profile'), screen('done', 'All set')],
    }),
    palette: SLATE,
    thumb: 'pending',
    written: new Set(),
    external: [],
    blocked: [],
    versions: [],
    dirty: false,
  });
  put('invoice-template', {
    design: baseDesign({ kind: 'artifact', title: 'Invoice template', updated: ago(DAY + 3 * HOUR), created: ago(4 * DAY), sessionId: null }),
    palette: SAGE,
    thumb: 'unavailable',
    written: new Set(['index']),
    external: [],
    blocked: ['../logo-source.psd'],
    versions: versions(1, false),
    dirty: false,
  });
  put('habit-tracker', {
    design: baseDesign({
      kind: 'canvas',
      title: 'Habit tracker explorations',
      updated: ago(3 * DAY),
      created: ago(6 * DAY),
      sessionId: 'ses_habit',
      screens: [screen('welcome', 'Welcome'), screen('profile', 'Profile')],
    }),
    palette: SLATE,
    thumb: 'ready',
    written: new Set(['welcome', 'profile']),
    external: [],
    blocked: [],
    versions: versions(3, false),
    dirty: false,
  });
  put('launch-announcement', {
    design: baseDesign({ kind: 'artifact', title: 'Launch announcement', updated: ago(9 * DAY), created: ago(10 * DAY), sessionId: null, comments: [] }),
    palette: SAGE,
    thumb: 'ready',
    written: new Set(['index']),
    external: [],
    blocked: [],
    versions: [],
    dirty: false,
  });
  return map;
};

// ---- thumbnails: a schematic PNG per palette, drawn on a canvas ----

const thumbCache = new Map<string, string>();

const drawThumb = (palette: Palette, kind: DesignKind): string => {
  const cached = thumbCache.get(`${palette.bg}${kind}`);
  if (cached) return cached;
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 200;
  const g = canvas.getContext('2d');
  if (!g) return '';
  g.fillStyle = palette.bg;
  g.fillRect(0, 0, 320, 200);
  g.fillStyle = palette.ink;
  g.fillRect(18, 16, 54, 8);
  g.fillStyle = palette.soft;
  for (let i = 0; i < 3; i += 1) g.fillRect(190 + i * 38, 17, 28, 6);
  g.fillStyle = palette.accent;
  g.beginPath();
  g.roundRect(268, 11, 36, 18, 9);
  g.fill();
  g.fillStyle = palette.ink;
  g.fillRect(18, 56, 150, 14);
  g.fillRect(18, 78, 118, 14);
  g.fillStyle = palette.soft;
  g.fillRect(18, 104, 140, 5);
  g.fillRect(18, 114, 112, 5);
  g.fillStyle = palette.accent;
  g.beginPath();
  g.roundRect(18, 132, 62, 20, 10);
  g.fill();
  if (kind === 'canvas') {
    g.fillStyle = palette.accent;
    g.beginPath();
    g.roundRect(204, 50, 98, 110, [48, 48, 10, 10]);
    g.fill();
  } else {
    g.fillStyle = palette.card;
    for (let i = 0; i < 3; i += 1) {
      g.beginPath();
      g.roundRect(182 + i * 40, 58, 36, 78, 6);
      g.fill();
    }
  }
  g.fillStyle = palette.card;
  for (let i = 0; i < 3; i += 1) {
    g.beginPath();
    g.roundRect(18 + i * 98, 168, 90, 32, [6, 6, 0, 0]);
    g.fill();
  }
  const data = canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  thumbCache.set(`${palette.bg}${kind}`, data);
  return data;
};

// ---- the database ----

const DEFAULT_ROOT = 'C:\\Users\\you\\Documents\\Designs';

export type FakeBackend = {
  call: <K extends RouteKey>(key: K, args: { params?: Record<string, string>; query?: Record<string, string>; body?: RouteBody<K> }) => Promise<RouteResponse<K>>;
  onChange: (listener: (event: ChangeEvent) => void) => () => void;
  /** Test hook: the agent finishes the pending onboarding design. */
  writePending: () => void;
};

export const createFakeBackend = (): FakeBackend => {
  const db = seed();
  let seq = 0;
  let nextId = 100;
  let root = DEFAULT_ROOT;
  const previous: SettingsResponse['previousRoots'] = [{ path: 'D:\\Old designs', exists: true, designCount: 3 }];
  let chromePath: string | null = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const listeners = new Set<(event: ChangeEvent) => void>();

  const emit = (slug: string | null, kind: ChangeEvent['kind'], files?: string[]): void => {
    seq += 1;
    const event: ChangeEvent = files ? { seq, slug, kind, files } : { seq, slug, kind };
    for (const listener of listeners) listener(event);
  };

  const get = (slug: string | undefined): Rec => {
    const rec = slug === undefined ? undefined : db.get(slug);
    if (!rec) throw new ServiceError('not-found', 'That design is no longer in your Designs folder.');
    return rec;
  };

  const rootVisible = (): boolean => root === DEFAULT_ROOT;

  const isPending = (rec: Rec): boolean => rec.written.size === 0;

  const summary = (slug: string, rec: Rec): DesignSummary => ({
    slug,
    kind: rec.design.kind,
    title: rec.design.title,
    created: rec.design.created,
    updated: rec.design.updated,
    pending: isPending(rec),
    screenCount: rec.design.screens.length,
    viewports: rec.design.viewports,
    sessionId: rec.design.sessionId,
    openComments: rec.design.comments.filter((c) => c.status === 'open').length,
    thumb: { state: rec.thumb, key: rec.thumb === 'ready' ? `${slug}:${rec.rev}` : null },
    warnings: [],
  });

  const docFor = (slug: string, rec: Rec, screenId: string | undefined, versionId: string | undefined): string => {
    const latest = rec.versions[rec.versions.length - 1]?.id;
    const old = versionId !== undefined && versionId !== latest;
    let html: string;
    if (slug === 'coffee-subscription') {
      html = screenId === 'pricing' ? coffeePricing() : screenId === 'checkout' ? coffeeCheckout() : coffeeHome();
      if (old) html = html.replace('Roasted this week.', 'Fresh coffee, monthly.').replace('Pick a rhythm', 'Choose a plan');
    } else if (slug === 'northwind-pricing' || slug === 'launch-announcement') {
      html = pricingArtifact();
    } else if (slug === 'invoice-template') {
      html = invoiceArtifact();
    } else {
      const found = rec.design.screens.find((s) => s.id === screenId);
      html = onboardingScreen(found?.title ?? 'Screen', `Step ${Math.max(1, rec.design.screens.findIndex((s) => s.id === screenId) + 1)} of ${rec.design.screens.length}`);
    }
    return html;
  };

  const touch = (rec: Rec): void => {
    rec.design.updated = new Date().toISOString();
    rec.rev += 1;
  };

  const detail = (slug: string, rec: Rec): RouteResponse<'GET /designs/:slug'> => {
    const screens: Record<string, { exists: boolean; size: number; mtime: string | null }> = {};
    for (const s of rec.design.screens) screens[s.id] = { exists: rec.written.has(s.id), size: rec.written.has(s.id) ? 18_400 : 0, mtime: rec.written.has(s.id) ? rec.design.updated : null };
    return {
      slug,
      path: `${root}\\${slug}`,
      design: rec.design,
      pending: isPending(rec),
      files: rec.design.kind === 'artifact' ? { entry: { exists: rec.written.has('index'), size: 22_000, mtime: rec.design.updated }, screens: {} } : { screens },
      warnings: [],
    };
  };

  type Req<K extends RouteKey> = { params: Record<string, string>; query: Record<string, string>; body: RouteBody<K> };
  type Handlers = { [K in RouteKey]?: (req: Req<K>) => RouteResponse<K> | Promise<RouteResponse<K>> };

  const handlers: Handlers = {
    'GET /health': () => ({ ok: true, version: '0.1.0', epoch: 'dev' }),
    'GET /settings': () => ({
      root,
      defaultRoot: DEFAULT_ROOT,
      previousRoots: previous.filter((p) => p.path !== root),
      rootExists: true,
      chrome: chromePath ? { path: chromePath, source: 'detected' } : { path: null, source: 'none' },
      downloadsDir: 'C:\\Users\\you\\Downloads',
    }),
    'PUT /settings': ({ body }) => {
      if (body.root !== undefined) {
        const next = body.root ?? DEFAULT_ROOT;
        if (!/^[A-Za-z]:[\\/]|^\//.test(next)) throw new ServiceError('bad-path', 'That folder cannot be used: it must be a full path.');
        if (/forbidden/i.test(next)) throw new ServiceError('bad-path', 'That folder cannot be used: Design Chamber cannot create it. Pick a folder you can write to.');
        if (next !== root && !previous.some((p) => p.path === root)) previous.unshift({ path: root, exists: true, designCount: db.size });
        root = next;
        emit(null, 'root');
      }
      if (body.chromePath !== undefined) {
        chromePath = body.chromePath;
      }
      return handlers['GET /settings']?.({ params: {}, query: {}, body: undefined }) as RouteResponse<'PUT /settings'>;
    },
    'GET /designs': ({ query }) => {
      let designs = rootVisible() ? [...db.entries()].map(([slug, rec]) => summary(slug, rec)) : [];
      if (query.q) designs = designs.filter((d) => d.title.toLowerCase().includes((query.q ?? '').toLowerCase()));
      return { root, designs };
    },
    'POST /designs': ({ body }) => {
      const slug = `${body.title ?? 'new-design'}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'design';
      const unique = db.has(slug) ? `${slug}-${(nextId += 1)}` : slug;
      const design = baseDesign({ kind: body.kind, title: body.title ?? 'Untitled design', brief: body.brief ?? '', created: new Date().toISOString(), updated: new Date().toISOString() });
      db.set(unique, { design, palette: SLATE, thumb: 'pending', written: new Set(), external: [], blocked: [], rev: 1, versions: [], dirty: false });
      emit(unique, 'added');
      return { slug: unique, path: `${root}\\${unique}`, design };
    },
    'GET /designs/:slug': ({ params }) => detail(params.slug ?? '', get(params.slug)),
    'PATCH /designs/:slug': ({ params, body }) => {
      const rec = get(params.slug);
      if (body.title !== undefined) rec.design.title = body.title;
      if (body.sessionId !== undefined) rec.design.sessionId = body.sessionId;
      touch(rec);
      emit(params.slug ?? null, 'design');
      return { design: rec.design };
    },
    'DELETE /designs/:slug': ({ params }) => {
      get(params.slug);
      db.delete(params.slug ?? '');
      emit(params.slug ?? null, 'removed');
      return { trashedTo: `${root}\\.trash\\${params.slug}-20261026180000` };
    },
    'POST /designs/:slug/comments': ({ params, body }) => {
      const rec = get(params.slug);
      nextId += 1;
      const created: Comment = { id: `c_n${nextId}`, screen: body.screen, viewport: body.viewport, anchor: body.anchor, body: body.body, status: 'open', created: new Date().toISOString(), sentAt: null, sentVersion: null };
      rec.design.comments.push(created);
      emit(params.slug ?? null, 'comments');
      return { comment: created };
    },
    'PATCH /designs/:slug/comments/:id': ({ params, body }) => {
      const rec = get(params.slug);
      const found = rec.design.comments.find((c) => c.id === params.id);
      if (!found) throw new ServiceError('not-found', 'That comment no longer exists.');
      if (body.body !== undefined) found.body = body.body;
      if (body.status !== undefined) found.status = body.status;
      emit(params.slug ?? null, 'comments');
      return { comment: found };
    },
    'DELETE /designs/:slug/comments/:id': ({ params }) => {
      const rec = get(params.slug);
      rec.design.comments = rec.design.comments.filter((c) => c.id !== params.id);
      emit(params.slug ?? null, 'comments');
      return { ok: true };
    },
    'POST /designs/:slug/comments/mark-sent': ({ params, body }) => {
      const rec = get(params.slug);
      const sent: Comment[] = [];
      for (const c of rec.design.comments) {
        if (body.ids.includes(c.id)) {
          c.status = 'sent';
          c.sentAt = new Date().toISOString();
          c.sentVersion = body.version;
          sent.push(c);
        }
      }
      emit(params.slug ?? null, 'comments');
      return { comments: sent };
    },
    'GET /designs/:slug/render': ({ params, query }) => {
      const rec = get(params.slug);
      const id = query.screen ?? (rec.design.kind === 'artifact' ? 'index' : (rec.design.screens.find((s) => rec.written.has(s.id))?.id ?? 'index'));
      if (!rec.written.has(id)) {
        const file = rec.design.kind === 'artifact' ? 'index.html' : `screens/${id}.html`;
        throw new ServiceError('no-html', `${file} has not been written yet.`);
      }
      const html = docFor(params.slug ?? '', rec, id === 'index' ? undefined : id, query.version);
      const blocked = params.slug === 'coffee-subscription' && query.screen === 'pricing' ? ['../private/brand-guide.pdf', 'module import ./app.js'] : rec.blocked;
      return { key: `${params.slug}:${id}:${query.version ?? 'cur'}:${rec.rev}`, chunks: 1, bytes: html.length, title: rec.design.title, missing: [], blocked, external: rec.external, warnings: [] };
    },
    'GET /designs/:slug/render/chunk': ({ params, query }) => {
      const rec = get(params.slug);
      const [, id, version] = (query.key ?? '').split(':');
      return docFor(params.slug ?? '', rec, id === 'index' ? undefined : id, version === 'cur' ? undefined : version);
    },
    'GET /designs/:slug/source': ({ params, query }) => {
      const rec = get(params.slug);
      const text = docFor(params.slug ?? '', rec, query.screen, undefined);
      return { text, bytes: text.length };
    },
    'GET /designs/:slug/thumbnail': ({ params }) => {
      const rec = get(params.slug);
      if (rec.thumb === 'ready') return { state: 'ready', key: `${params.slug}:${rec.rev}`, png: drawThumb(rec.palette, rec.design.kind), width: 320, height: 200 };
      if (rec.thumb === 'unavailable') return { state: 'unavailable', key: null, message: 'No Chrome or Edge was found, so this shows a live preview.' };
      return { state: 'pending', key: null };
    },
    'GET /designs/:slug/versions': ({ params }) => {
      const rec = get(params.slug);
      return { versions: rec.versions, currentTreeHash: 'current', dirty: rec.dirty };
    },
    'POST /designs/:slug/versions': ({ params }) => {
      const rec = get(params.slug);
      const n = (rec.versions[rec.versions.length - 1]?.n ?? 0) + 1;
      if (!rec.dirty && rec.versions.length > 0) return { created: null };
      const created: VersionSummary = { id: `v${n}`, n, created: new Date().toISOString(), reason: 'manual', sessionId: null, treeHash: `tree${n}`, bytes: 30_000, fileCount: 8 };
      rec.versions.push(created);
      rec.dirty = false;
      emit(params.slug ?? null, 'versions');
      return { created };
    },
    'GET /designs/:slug/versions/:vid/diff': () => ({
      files: [
        { path: 'screens/home.html', change: 'modified' },
        { path: 'screens/pricing.html', change: 'modified' },
        { path: 'assets/hero.png', change: 'added' },
        { path: 'screens/legacy.html', change: 'removed' },
      ],
    }),
    'POST /designs/:slug/versions/:vid/restore': ({ params }) => {
      const rec = get(params.slug);
      const target = rec.versions.find((v) => v.id === params.vid);
      if (!target) throw new ServiceError('not-found', 'That version is no longer saved.');
      const n = (rec.versions[rec.versions.length - 1]?.n ?? 0) + 1;
      const point: VersionSummary = { id: `v${n}`, n, created: new Date().toISOString(), reason: 'restore-point', sessionId: null, treeHash: `tree${n}`, bytes: 30_000, fileCount: 8 };
      rec.versions.push(point);
      const restored: VersionSummary = { id: `v${n + 1}`, n: n + 1, created: new Date().toISOString(), reason: 'restored', sessionId: null, treeHash: target.treeHash, bytes: target.bytes, fileCount: target.fileCount };
      rec.versions.push(restored);
      touch(rec);
      emit(params.slug ?? null, 'versions');
      emit(params.slug ?? null, 'files');
      return { restorePoint: point, restored };
    },
    'POST /designs/:slug/export': ({ params, body }) => {
      get(params.slug);
      return { path: `C:\\Users\\you\\Downloads\\${params.slug}${body.format === 'zip' ? '.zip' : '.html'}`, bytes: 184_320, format: body.format };
    },
    'POST /reveal': () => ({ ok: true }),
    'GET /presets': () => ({
      presets: [
        { id: 'minimal-saas', name: 'Minimal SaaS', bestFor: 'dashboards, settings' },
        { id: 'editorial', name: 'Editorial', bestFor: 'content, blogs' },
        { id: 'playful-consumer', name: 'Playful consumer', bestFor: 'apps, onboarding' },
      ],
    }),
    'POST /designs/:slug/prompt': () => {
      throw new ServiceError('internal', 'Not needed by the UI shim.');
    },
  };

  const call: FakeBackend['call'] = async (key, args) => {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));
    const handler = handlers[key];
    if (!handler) throw new ServiceError('internal', `The fake service does not implement ${key}.`);
    // Safe: `handlers[key]` is typed per key; the generic key loses that link here, and the
    // request shape is the one `ApiRoutes[key]` declares.
    const run = handler as (req: Req<typeof key>) => RouteResponse<typeof key> | Promise<RouteResponse<typeof key>>;
    return run({ params: args.params ?? {}, query: args.query ?? {}, body: args.body as RouteBody<typeof key> });
  };

  const writePending = (): void => {
    const rec = db.get('onboarding-flow');
    if (!rec) return;
    rec.written = new Set(['welcome', 'profile', 'done']);
    rec.thumb = 'ready';
    touch(rec);
    emit('onboarding-flow', 'files', ['design.json', 'screens/welcome.html', 'screens/profile.html', 'screens/done.html']);
    emit('onboarding-flow', 'design');
  };

  return {
    call,
    onChange: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    writePending,
  };
};

export type { ApiRoutes };
