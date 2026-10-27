// In-memory stand-ins for the host and the local service (docs/SPEC.md §14 WP4), for UI
// development without OpenChamber and for guest-core tests. Not imported by any production
// entry: the UI opts in explicitly (e.g. a `?fake` switch in a dev build).
//
//   const { guestHost, client, host, service } = createFakeServices();
//   const store = createStore({ client });
//   const flows = createFlows({ host: guestHost, client });
//   host.emitReady({ surface: 'page' });

import {
  HostRequestError,
  type GuestItem,
  type GuestProject,
  type GuestRequest,
  type GuestRequestResult,
  type GuestSessionRecord,
  type GuestSessionsSnapshot,
  type HostReadyContext,
  type HostThemeTokens,
  type JsonValue,
  type PromptRequest,
  type PromptResult,
  type SessionLifecycleEvent,
  type SessionSnapshot,
  type StartSessionRequest,
  type StartSessionResult,
} from '@openchamber/sdk';

import { API_ERROR_STATUS, ROUTE_KEYS, splitRouteKey, type ApiErrorCode, type ChangesResponse, type OpenRequest, type RouteKey } from '../shared/api.ts';
import { CHIP_PROVIDER_ID, type ChangeEvent, type ChangeKind, type Comment, type DesignJson, type DesignKind, type DesignSummary, type Outbox, type Preset, type VersionSummary, type Viewport } from '../shared/types.ts';
import { CHANGES_RING_SIZE } from '../shared/limits.ts';
import { createGuestHost, type GuestHost, type HostLike } from './host.ts';
import { createServiceClient, type ServiceClient } from './service-client.ts';

// ---- Sample content ----

const LAPTOP: Viewport = { id: 'laptop', label: 'Laptop', width: 1280, height: 800 };
const PHONE: Viewport = { id: 'phone', label: 'Phone', width: 390, height: 844 };

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>` +
  '<style>body{margin:0;font-family:Georgia,serif;background:#f6f1ea;color:#2b211a}header,main,section,footer{padding:32px 6vw}' +
  'nav a{margin-right:16px;color:inherit}h1{font-size:clamp(32px,6vw,64px);margin:0 0 12px}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px}' +
  '.card{background:#fff;border:1px solid #e3d9cc;padding:20px}.cta{display:inline-block;padding:12px 20px;background:#2b211a;color:#f6f1ea;text-decoration:none}</style></head>' +
  `<body>${body}</body></html>`;

const SAMPLE_FILES: Record<string, Record<string, string>> = {
  'coffee-subscription': {
    'screens/home.html': page(
      'Home',
      '<header><nav><a href="home.html">Home</a><a href="pricing.html">Pricing</a><a href="https://example.com/about">About us</a></nav></header>' +
        '<main><section class="hero"><h1>Fresh roasts, every other Monday</h1><p>Single-origin beans from small farms, roasted the week they ship.</p>' +
        '<a class="cta" href="pricing.html#plans">See plans</a></section>' +
        '<section class="cards"><div class="card"><h2>Pick a roast</h2><p>Light, medium or dark — switch any time.</p></div>' +
        '<div class="card"><h2>Set the rhythm</h2><p>Weekly, fortnightly or monthly deliveries.</p></div>' +
        '<div class="card"><h2>Pause freely</h2><p>Skip a box from your account in one tap.</p></div></section></main>' +
        '<footer><p>Roasted in Leeds · Free delivery over £30</p></footer>',
    ),
    'screens/pricing.html': page(
      'Pricing',
      '<header><nav><a href="home.html">Home</a><a href="pricing.html">Pricing</a></nav></header>' +
        '<main><h1 id="plans">Plans</h1><div class="cards">' +
        '<div class="card" data-testid="plan-taster"><h2>Taster</h2><p>£12 / box · 250 g</p><button data-dc-goto="home">Start with Taster</button></div>' +
        '<div class="card" data-testid="plan-regular"><h2>Regular</h2><p>£21 / box · 500 g</p><button data-dc-goto="home">Start with Regular</button></div>' +
        '</div></main>',
    ),
  },
  'launch-announcement': {
    'index.html': page(
      'Launch announcement',
      '<main><h1>Design Chamber is here</h1><p>Designs your chat agent writes, rendered right inside OpenChamber.</p>' +
        '<form><label>Email <input type="email" placeholder="you@example.com"></label><button>Notify me</button></form></main>',
    ),
  },
};

const iso = (offsetMinutes: number): string => new Date(Date.UTC(2026, 9, 26, 18, 0) + offsetMinutes * 60_000).toISOString();

const baseDesign = (kind: DesignKind, title: string, minutes: number): DesignJson => ({
  version: 1,
  kind,
  title,
  created: iso(minutes),
  updated: iso(minutes + 20),
  brief: '',
  sessionId: null,
  projectDirectory: null,
  preset: null,
  entry: kind === 'artifact' ? 'index.html' : null,
  viewports: kind === 'artifact' ? [LAPTOP] : [LAPTOP, PHONE],
  screens: [],
  designSystem: { confirmed: false },
  comments: [],
});

type FakeDesign = { design: DesignJson; files: Record<string, string>; versions: VersionSummary[] };

const sampleDesigns = (): Map<string, FakeDesign> => {
  const designs = new Map<string, FakeDesign>();
  const coffee = baseDesign('canvas', 'Coffee subscription', 0);
  coffee.brief = 'A pricing page for a coffee subscription';
  coffee.sessionId = 'ses_fake_coffee';
  coffee.screens = [
    { id: 'home', title: 'Home', file: 'screens/home.html' },
    { id: 'pricing', title: 'Pricing', file: 'screens/pricing.html' },
  ];
  coffee.comments = [
    {
      id: 'c_hero01',
      screen: 'home',
      viewport: 'laptop',
      anchor: {
        selector: 'main > section.hero > h1',
        text: 'Fresh roasts, every other Monday',
        html: '<h1>',
        rect: { x: 77, y: 120, w: 1126, h: 77 },
        point: { x: 0.1, y: 0.5 },
      },
      body: 'Make the headline shorter and warmer.',
      status: 'open',
      created: iso(30),
      sentAt: null,
      sentVersion: null,
    },
  ];
  designs.set('coffee-subscription', { design: coffee, files: { ...SAMPLE_FILES['coffee-subscription'] }, versions: [] });

  const launch = baseDesign('artifact', 'Launch announcement', 60);
  designs.set('launch-announcement', { design: launch, files: { ...SAMPLE_FILES['launch-announcement'] }, versions: [] });

  const onboarding = baseDesign('canvas', 'Onboarding flow', 120);
  onboarding.brief = 'Three-step onboarding for a budgeting app';
  designs.set('onboarding-flow', { design: onboarding, files: {}, versions: [] });

  for (const entry of designs.values()) if (Object.keys(entry.files).length > 0) pushVersion(entry, 'auto', null);
  return designs;
};

let versionCounter = 0;
const pushVersion = (entry: FakeDesign, reason: VersionSummary['reason'], sessionId: string | null): VersionSummary => {
  versionCounter += 1;
  const n = (entry.versions.at(-1)?.n ?? 0) + 1;
  const version: VersionSummary = {
    id: `v${n}`,
    n,
    created: new Date(Date.UTC(2026, 9, 26, 18, 30) + versionCounter * 60_000).toISOString(),
    reason,
    sessionId,
    treeHash: fakeHash(JSON.stringify(entry.files) + n),
    bytes: Object.values(entry.files).reduce((sum, text) => sum + text.length, 0),
    fileCount: Object.keys(entry.files).length,
  };
  entry.versions.push(version);
  return version;
};

/** 64 hex chars from a string (FNV-1a, repeated): a stand-in for sha256 keys. */
export const fakeHash = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0').repeat(8);
};

const PRESETS: Preset[] = [
  { id: 'minimal-saas', name: 'Minimal SaaS', bestFor: 'Dashboards and product marketing' },
  { id: 'editorial', name: 'Editorial', bestFor: 'Long-form and content sites' },
];

// ---- Fake service ----

class FakeHttpError extends Error {
  readonly code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

type Matched = { key: RouteKey; params: Record<string, string> };

const matchRoute = (method: string, path: string): Matched | null => {
  const segments = path.split('/').filter(Boolean).map(decodeURIComponent);
  for (const key of ROUTE_KEYS) {
    const route = splitRouteKey(key);
    if (route.method !== method) continue;
    const pattern = route.pattern.split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (const [index, part] of pattern.entries()) {
      const value = segments[index] ?? '';
      if (part.startsWith(':')) params[part.slice(1)] = value;
      else if (part !== value) ok = false;
    }
    if (ok) return { key, params };
  }
  return null;
};

export type FakeServiceOptions = {
  /** Characters per render chunk (default: one chunk). */
  renderChunkChars?: number;
  /** Start empty instead of with the sample designs. */
  empty?: boolean;
};

export type FakeService = {
  handle(request: GuestRequest): Promise<GuestRequestResult>;
  readonly designs: Map<string, FakeDesign>;
  outbox: Outbox | null;
  /** Every request, in order (method + path). */
  readonly requests: GuestRequest[];
  /** Record a change event (also emitted by every fake mutation). */
  emit(slug: string | null, kind: ChangeKind, files?: string[]): void;
  /** Simulate the agent writing a file. */
  writeFile(slug: string, file: string, text: string): void;
};

export const createFakeService = (options: FakeServiceOptions = {}): FakeService => {
  const designs = options.empty ? new Map<string, FakeDesign>() : sampleDesigns();
  const epoch = fakeHash(String(Math.random())).slice(0, 16);
  const events: ChangeEvent[] = [];
  let seq = 0;
  const waiters = new Set<() => void>();
  const uploads = new Map<string, { total: number; parts: string[] }>();
  const renders = new Map<string, string>();
  const requests: GuestRequest[] = [];
  let root = 'C:\\Users\\you\\Documents\\Designs';
  let counter = 0;
  const outbox: { value: Outbox | null } = { value: null };
  const openRequest: { value: OpenRequest | null } = { value: null };

  const emit = (slug: string | null, kind: ChangeKind, files?: string[]): void => {
    seq += 1;
    events.push(files ? { seq, slug, kind, files } : { seq, slug, kind });
    if (events.length > CHANGES_RING_SIZE) events.shift();
    for (const wake of [...waiters]) wake();
  };

  const get = (slug: string): FakeDesign => {
    const entry = designs.get(slug);
    if (!entry) throw new FakeHttpError('not-found', 'That design no longer exists. It may have been deleted.');
    return entry;
  };

  const pending = (entry: FakeDesign): boolean =>
    entry.design.kind === 'artifact' ? !entry.files['index.html'] : !entry.design.screens.some((screen) => entry.files[screen.file]);

  const summary = (slug: string, entry: FakeDesign): DesignSummary => ({
    slug,
    kind: entry.design.kind,
    title: entry.design.title,
    created: entry.design.created,
    updated: entry.design.updated,
    pending: pending(entry),
    screenCount: entry.design.screens.length,
    viewports: entry.design.viewports,
    sessionId: entry.design.sessionId,
    openComments: entry.design.comments.filter((comment) => comment.status === 'open').length,
    thumb: { state: 'unavailable', key: null },
    warnings: [],
  });

  const fileStatus = (text: string | undefined) => ({ exists: text !== undefined, size: text?.length ?? 0, mtime: text === undefined ? null : iso(20) });

  const touch = (entry: FakeDesign): void => {
    entry.design.updated = new Date().toISOString();
  };

  const createDesign = (kind: DesignKind, title: string, brief: string, extra: Partial<DesignJson> = {}, html?: string): string => {
    const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'design';
    let slug = base;
    for (let n = 2; designs.has(slug); n += 1) slug = `${base}-${n}`;
    const design = { ...baseDesign(kind, title, 0), created: new Date().toISOString(), updated: new Date().toISOString(), brief, ...extra };
    designs.set(slug, { design, files: html ? { 'index.html': html } : {}, versions: [] });
    emit(slug, 'added');
    return slug;
  };

  const chipOf = (slug: string) => {
    const entry = get(slug);
    return {
      providerId: CHIP_PROVIDER_ID,
      id: `design:${slug}`,
      title: entry.design.title,
      url: `file:///C:/Users/you/Documents/Designs/${slug}`,
      text: `[Design Chamber] ${entry.design.kind === 'canvas' ? 'New canvas' : 'New artifact'}: "${entry.design.title}"\nWrite ONLY inside: ${root}\\${slug}`,
      data: { slug, kind: entry.design.kind },
    } as const;
  };

  /** The fake keeps no file history: a version renders the current files. */
  const sourceOf = (slug: string, screen: string | undefined): string => {
    const entry = get(slug);
    const file = entry.design.kind === 'artifact' ? 'index.html' : entry.design.screens.find((item) => item.id === screen)?.file;
    if (!file) throw new FakeHttpError('not-found', 'That screen is not part of this design.');
    const text = entry.files[file];
    if (text === undefined) throw new FakeHttpError('not-found', `${file} is not written yet.`);
    return text;
  };

  const route = async ({ key, params }: Matched, query: Record<string, string>, body: Record<string, unknown>): Promise<unknown> => {
    const slug = params.slug ?? '';
    switch (key) {
      case 'GET /health':
        return { ok: true, version: '0.1.0-fake', epoch };
      case 'GET /settings':
      case 'PUT /settings': {
        if (key === 'PUT /settings' && typeof body.root === 'string') {
          if (!/^([A-Za-z]:\\|\/)/.test(body.root)) throw new FakeHttpError('bad-path', 'Choose a full folder path, like C:\\Users\\you\\Designs.');
          root = body.root;
          emit(null, 'root');
        }
        return {
          root,
          defaultRoot: 'C:\\Users\\you\\Documents\\Designs',
          previousRoots: [],
          rootExists: true,
          chrome: { path: null, source: 'none' },
          downloadsDir: 'C:\\Users\\you\\Downloads',
        };
      }
      case 'GET /changes': {
        const since = Number(query.since ?? '0');
        const wait = Math.min(Number(query.wait ?? '0'), 15_000);
        const reset = query.epoch !== epoch || (events.length > 0 && since < (events[0]?.seq ?? 0) - 1);
        if (!reset && since >= seq && wait > 0) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(done, wait);
            function done(): void {
              clearTimeout(timer);
              waiters.delete(done);
              resolve();
            }
            waiters.add(done);
          });
        }
        const answer: ChangesResponse = { epoch, seq, reset, events: reset ? [] : events.filter((event) => event.seq > since) };
        return answer;
      }
      case 'GET /designs': {
        const list = [...designs.entries()]
          .map(([name, entry]) => summary(name, entry))
          .filter((item) => (!query.kind || item.kind === query.kind) && (!query.q || item.title.toLowerCase().includes(query.q.toLowerCase())))
          .sort((a, b) => b.updated.localeCompare(a.updated));
        return { root, designs: list };
      }
      case 'POST /designs': {
        const kind = body.kind === 'artifact' ? 'artifact' : 'canvas';
        const created = createDesign(kind, typeof body.title === 'string' && body.title ? body.title : 'Untitled design', typeof body.brief === 'string' ? body.brief : '', {}, typeof body.html === 'string' ? body.html : undefined);
        return { slug: created, path: `${root}\\${created}`, design: get(created).design };
      }
      case 'GET /designs/:slug': {
        const entry = get(slug);
        const screens: Record<string, ReturnType<typeof fileStatus>> = {};
        for (const screen of entry.design.screens) screens[screen.id] = fileStatus(entry.files[screen.file]);
        return {
          slug,
          path: `${root}\\${slug}`,
          design: entry.design,
          pending: pending(entry),
          files: entry.design.kind === 'artifact' ? { entry: fileStatus(entry.files['index.html']), screens } : { screens },
          warnings: [],
        };
      }
      case 'PATCH /designs/:slug': {
        const entry = get(slug);
        if (typeof body.title === 'string') entry.design.title = body.title;
        if (body.sessionId === null || typeof body.sessionId === 'string') entry.design.sessionId = body.sessionId;
        if (body.projectDirectory === null || typeof body.projectDirectory === 'string') entry.design.projectDirectory = body.projectDirectory;
        touch(entry);
        emit(slug, 'design');
        return { design: entry.design };
      }
      case 'DELETE /designs/:slug':
        get(slug);
        designs.delete(slug);
        emit(slug, 'removed');
        return { trashedTo: `${root}\\.trash\\${slug}-20261026180000` };
      case 'POST /designs/:slug/comments': {
        const entry = get(slug);
        counter += 1;
        const comment: Comment = {
          id: `c_${counter.toString(36).padStart(4, '0')}${Math.random().toString(36).slice(2, 6)}`,
          screen: (body.screen as string | null) ?? null,
          viewport: String(body.viewport),
          // Safe: fake data for UI development; the real service validates (WP1).
          anchor: body.anchor as Comment['anchor'],
          body: String(body.body),
          status: 'open',
          created: new Date().toISOString(),
          sentAt: null,
          sentVersion: null,
        };
        entry.design.comments.push(comment);
        emit(slug, 'comments');
        return { comment };
      }
      case 'PATCH /designs/:slug/comments/:id':
      case 'DELETE /designs/:slug/comments/:id': {
        const entry = get(slug);
        const comment = entry.design.comments.find((item) => item.id === params.id);
        if (!comment) throw new FakeHttpError('not-found', 'That comment no longer exists.');
        emit(slug, 'comments');
        if (key.startsWith('DELETE')) {
          entry.design.comments = entry.design.comments.filter((item) => item.id !== params.id);
          return { ok: true };
        }
        if (typeof body.body === 'string') comment.body = body.body;
        if (body.status === 'open' || body.status === 'sent' || body.status === 'resolved') comment.status = body.status;
        return { comment };
      }
      case 'POST /designs/:slug/comments/mark-sent': {
        const entry = get(slug);
        const ids = new Set(Array.isArray(body.ids) ? body.ids : []);
        const changed = entry.design.comments.filter((comment) => ids.has(comment.id));
        for (const comment of changed) {
          comment.status = 'sent';
          comment.sentAt = new Date().toISOString();
          comment.sentVersion = typeof body.version === 'number' ? body.version : null;
        }
        emit(slug, 'comments');
        return { comments: changed };
      }
      case 'POST /uploads': {
        counter += 1;
        const uploadId = `u_fake${counter.toString().padStart(8, '0')}`;
        uploads.set(uploadId, { total: Number(body.total), parts: [] });
        return { uploadId };
      }
      case 'PUT /uploads/:id/:index': {
        const upload = uploads.get(params.id ?? '');
        if (!upload) throw new FakeHttpError('not-found', 'The upload expired. Try again.');
        upload.parts[Number(params.index)] = String(body.data);
        const received = upload.parts.join('').length;
        return { received, complete: received === upload.total };
      }
      case 'GET /outbox':
        return { outbox: outbox.value };
      case 'PUT /outbox':
        outbox.value = {
          sessionId: String(body.sessionId),
          slug: String(body.slug),
          text: String(body.text),
          commentIds: Array.isArray(body.commentIds) ? body.commentIds.map(String) : [],
          version: typeof body.version === 'number' ? body.version : null,
          created: new Date().toISOString(),
        };
        return { outbox: outbox.value };
      case 'DELETE /outbox': {
        const taken = outbox.value;
        outbox.value = null;
        return { outbox: taken };
      }
      case 'DELETE /open-request': {
        const taken = openRequest.value;
        openRequest.value = null;
        return { request: taken };
      }
      case 'GET /designs/:slug/render': {
        const html = sourceOf(slug, query.screen);
        const renderKey = fakeHash(`${slug}|${query.screen ?? ''}|${query.version ?? ''}|${html}`);
        renders.set(renderKey, html);
        const size = options.renderChunkChars ?? Math.max(1, html.length);
        return {
          key: renderKey,
          chunks: Math.max(1, Math.ceil(html.length / size)),
          bytes: html.length,
          title: /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? '',
          missing: [],
          blocked: [],
          external: [],
          warnings: [],
        };
      }
      case 'GET /designs/:slug/render/chunk': {
        const html = renders.get(query.key ?? '');
        if (html === undefined) throw new FakeHttpError('stale', 'The preview changed while loading. Loading it again.');
        const size = options.renderChunkChars ?? Math.max(1, html.length);
        const n = Number(query.n ?? '0');
        return html.slice(n * size, (n + 1) * size);
      }
      case 'GET /designs/:slug/source': {
        const text = sourceOf(slug, query.screen);
        return { text, bytes: text.length };
      }
      case 'GET /designs/:slug/thumbnail':
        get(slug);
        return { state: 'unavailable', key: null, message: 'No Chrome or Edge found — showing live previews instead.' };
      case 'POST /designs/:slug/thumbnail/refresh':
        get(slug);
        return { state: 'unavailable' };
      case 'GET /designs/:slug/versions': {
        const entry = get(slug);
        const newest = entry.versions.at(-1);
        return { versions: [...entry.versions], currentTreeHash: newest?.treeHash ?? fakeHash(slug), dirty: false };
      }
      case 'POST /designs/:slug/versions': {
        const entry = get(slug);
        const created = pushVersion(entry, body.reason === 'turn' ? 'turn' : 'manual', typeof body.sessionId === 'string' ? body.sessionId : null);
        if (typeof body.label === 'string') created.label = body.label;
        emit(slug, 'versions');
        return { created };
      }
      case 'POST /versions/turn': {
        const created: { slug: string; id: string }[] = [];
        for (const [name, entry] of designs) {
          if (entry.design.sessionId !== body.sessionId) continue;
          created.push({ slug: name, id: pushVersion(entry, 'turn', String(body.sessionId)).id });
          emit(name, 'versions');
        }
        return { created };
      }
      case 'GET /designs/:slug/versions/:vid/diff':
        get(slug);
        return { files: [] };
      case 'POST /designs/:slug/versions/:vid/restore': {
        const entry = get(slug);
        if (!entry.versions.some((version) => version.id === params.vid)) throw new FakeHttpError('not-found', 'That version no longer exists.');
        const restorePoint = pushVersion(entry, 'restore-point', null);
        const restored = pushVersion(entry, 'restored', null);
        emit(slug, 'versions');
        emit(slug, 'files', Object.keys(entry.files));
        return { restorePoint, restored };
      }
      case 'POST /designs/:slug/export': {
        get(slug);
        const format = body.format === 'html' ? 'html' : 'zip';
        return { path: `C:\\Users\\you\\Downloads\\${slug}.${format}`, bytes: 48_213, format };
      }
      case 'POST /reveal':
        return { ok: true };
      case 'GET /presets':
        return { presets: PRESETS };
      case 'POST /chip': {
        const kind = body.kind === 'artifact' ? 'artifact' : 'canvas';
        const brief = typeof body.brief === 'string' ? body.brief : '';
        const title = brief ? brief.slice(0, 60) : kind === 'artifact' ? 'Untitled artifact' : 'Untitled design';
        const created = createDesign(kind, title, brief, {
          projectDirectory: typeof body.projectDirectory === 'string' ? body.projectDirectory : null,
          preset: typeof body.preset === 'string' ? body.preset : null,
        });
        return { slug: created, chip: chipOf(created) };
      }
      case 'POST /designs/:slug/prompt': {
        const entry = get(slug);
        const wanted = Array.isArray(body.commentIds) ? new Set(body.commentIds.map(String)) : null;
        const comments = entry.design.comments.filter((comment) => comment.status === 'open' && (!wanted || wanted.has(comment.id)));
        const text =
          body.purpose === 'revision'
            ? `[Design Chamber] Revise "${entry.design.title}" — ${comments.length} comment(s).\n` +
              comments.map((comment, index) => `${index + 1}. element: \`${comment.anchor.selector}\`\n   → ${comment.body}`).join('\n')
            : `[Design Chamber] Let's continue "${entry.design.title}".`;
        return { text, commentIds: body.purpose === 'revision' ? comments.map((comment) => comment.id) : [], omitted: [], chip: chipOf(slug) };
      }
      case 'POST /artifacts/from-message': {
        const upload = uploads.get(String(body.uploadId));
        if (!upload) throw new FakeHttpError('not-found', 'The upload expired. Try again.');
        const text = upload.parts.join('');
        const html = /```html?\s*\n([\s\S]*?)```/i.exec(text)?.[1];
        if (!html) throw new FakeHttpError('no-html', 'No HTML code block in this message.');
        const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? String(body.sessionTitle || 'Artifact from chat');
        const created = createDesign('artifact', title, '', { sessionId: String(body.sessionId) }, html);
        if (body.open === true) openRequest.value = { slug: created, created: new Date().toISOString() };
        return { slug: created, title };
      }
    }
  };

  const handle = async (request: GuestRequest): Promise<GuestRequestResult> => {
    requests.push(request);
    const matched = matchRoute(request.method, request.path);
    if (!matched) return { status: 404, body: JSON.stringify({ error: 'not-found', message: 'Unknown route.' }) };
    let body: Record<string, unknown> = {};
    if (request.body) {
      const parsed: unknown = JSON.parse(request.body);
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Record<string, unknown>;
    }
    try {
      const answer = await route(matched, request.query ?? {}, body);
      return { status: 200, body: typeof answer === 'string' ? answer : JSON.stringify(answer) };
    } catch (error) {
      if (error instanceof FakeHttpError) return { status: API_ERROR_STATUS[error.code], body: JSON.stringify({ error: error.code, message: error.message }) };
      throw error;
    }
  };

  return {
    handle,
    designs,
    get outbox() {
      return outbox.value;
    },
    set outbox(value: Outbox | null) {
      outbox.value = value;
    },
    requests,
    emit,
    writeFile: (slug, file, text) => {
      const entry = get(slug);
      entry.files[file] = text;
      touch(entry);
      emit(slug, 'files', [file]);
    },
  };
};

// ---- Fake host ----

export const FAKE_THEME_TOKENS: HostThemeTokens = {
  background: '#151313',
  elevated: '#1d1b1a',
  foreground: '#ece6df',
  muted: '#a49b91',
  subtle: '#7d756c',
  border: '#34302d',
  hover: '#262321',
  selection: '#3a3430',
  focus: '#d8a25e',
  primary: '#d8a25e',
  mutedSurface: '#1a1817',
  elevatedForeground: '#ece6df',
  active: '#2e2a27',
  selectionForeground: '#ece6df',
  primaryForeground: '#1a1410',
  primaryText: '#e2b47a',
  successText: '#8fc79a',
  warningText: '#e0bb6a',
  errorText: '#ec8b7f',
  infoText: '#86b4e0',
  success: '#5f9f6b',
  warning: '#c79a3c',
  error: '#c4574b',
  info: '#4f84b8',
  font: 'system-ui, sans-serif',
  mono: 'ui-monospace, monospace',
  radius: '6px',
};

export type FakeHostCall = { method: string; args: unknown[] };

/** Per-method overrides; return a value or throw a `HostRequestError` to simulate the host. */
export type FakeHostBehavior = {
  prompt?: (request: PromptRequest) => Promise<PromptResult>;
  startSession?: (request: StartSessionRequest) => Promise<StartSessionResult>;
  openSession?: (sessionId: string) => Promise<void>;
  openSurface?: (surfaceId: string) => Promise<void>;
};

export type FakeHostOptions = {
  service?: FakeService;
  surface?: HostReadyContext['surface'];
  directory?: string | null;
  session?: SessionSnapshot | null;
  projects?: GuestProject[];
  /** Sessions `openSession` accepts; others throw NO_SESSION. */
  knownSessions?: string[];
};

export type FakeHost = HostLike & {
  readonly calls: FakeHostCall[];
  callsOf(method: string): unknown[][];
  behavior: FakeHostBehavior;
  readonly knownSessions: Set<string>;
  projects: GuestProject[];
  /** Push a ready snapshot (merged over the current one). */
  emitReady(patch?: Partial<HostReadyContext>): HostReadyContext;
  setSession(session: SessionSnapshot | null): void;
  setDirectory(directory: string | null): void;
  setItem(item: GuestItem | null): void;
  emitLifecycle(event: SessionLifecycleEvent): void;
  /** Push a sessions snapshot to `onSessions(projectId)` listeners. */
  emitSessions(projectId: string, sessions: GuestSessionRecord[], state?: GuestSessionsSnapshot['state']): void;
  /** The handler the guest registered with `onResolve`. */
  resolver(): Parameters<HostLike['onResolve']>[0] | null;
  /** The handler the guest registered with `onAction`. */
  actionHandler(): Parameters<HostLike['onAction']>[0] | null;
};

export const createFakeHost = (options: FakeHostOptions = {}): FakeHost => {
  const service = options.service ?? createFakeService();
  const calls: FakeHostCall[] = [];
  const record = (method: string, ...args: unknown[]): void => {
    calls.push({ method, args });
  };
  const knownSessions = new Set(options.knownSessions ?? ['ses_fake_coffee']);
  let context: HostReadyContext = {
    theme: { mode: 'dark', tokens: FAKE_THEME_TOKENS },
    locale: 'en',
    directory: options.directory === undefined ? 'C:\\Users\\you\\projects\\shop' : options.directory,
    session: options.session ?? null,
    surface: options.surface ?? 'page',
    connection: { connected: true, account: '' },
    settings: {},
    item: null,
  };
  let emittedReady = false;
  let item: GuestItem | null = null;
  const storage = new Map<string, JsonValue>();
  let resolver: Parameters<HostLike['onResolve']>[0] | null = null;
  let actionHandler: Parameters<HostLike['onAction']>[0] | null = null;

  const readyListeners = new Set<(ctx: HostReadyContext) => void>();
  const sessionListeners = new Set<(session: SessionSnapshot | null) => void>();
  const directoryListeners = new Set<(directory: string | null) => void>();
  const itemListeners = new Set<(item: GuestItem | null) => void>();
  const lifecycleListeners = new Set<(event: SessionLifecycleEvent) => void>();
  const sessionsListeners = new Map<string, Set<(snapshot: GuestSessionsSnapshot) => void>>();
  const sessionsSnapshots = new Map<string, GuestSessionsSnapshot>();

  const listen = <T>(set: Set<(value: T) => void>, listener: (value: T) => void, replay: (() => T) | null): (() => void) => {
    set.add(listener);
    if (replay) listener(replay());
    return () => set.delete(listener);
  };

  const setSession = (session: SessionSnapshot | null): void => {
    context = { ...context, session };
    for (const listener of [...sessionListeners]) listener(session);
  };

  const fake: FakeHost = {
    calls,
    callsOf: (method) => calls.filter((call) => call.method === method).map((call) => call.args),
    behavior: {},
    knownSessions,
    projects: options.projects ?? [{ id: 'proj_shop', name: 'shop', directory: 'C:\\Users\\you\\projects\\shop' }],

    onReady: (listener) => listen(readyListeners, listener, emittedReady ? () => context : null),
    onSession: (listener) => listen(sessionListeners, listener, () => context.session),
    onDirectory: (listener) => listen(directoryListeners, listener, () => context.directory),
    onItem: (listener) => listen(itemListeners, listener, () => item),
    onSessionLifecycle: (listener) => listen(lifecycleListeners, listener, null),
    onResolve: (handler) => {
      resolver = handler;
      return () => {
        resolver = null;
      };
    },
    onAction: (handler) => {
      actionHandler = handler;
      return () => {
        actionHandler = null;
      };
    },

    serviceRequest: (request) => service.handle(request),

    listProjects: async () => ({ kind: 'projects', state: 'ready', projects: fake.projects }),
    onSessions: async (projectId, listener) => {
      const set = sessionsListeners.get(projectId) ?? new Set();
      sessionsListeners.set(projectId, set);
      set.add(listener);
      const current = sessionsSnapshots.get(projectId);
      if (current) listener(current);
      return () => set.delete(listener);
    },

    openSession: async (sessionId) => {
      record('openSession', sessionId);
      if (fake.behavior.openSession) return fake.behavior.openSession(sessionId);
      if (!knownSessions.has(sessionId)) throw new HostRequestError('NO_SESSION', 'That session does not exist.');
      setSession({ id: sessionId, title: 'Chat', busy: false });
    },
    openSurface: async (surfaceId) => {
      record('openSurface', surfaceId);
      if (fake.behavior.openSurface) return fake.behavior.openSurface(surfaceId);
    },
    startSession: async (request) => {
      record('startSession', request);
      if (fake.behavior.startSession) return fake.behavior.startSession(request);
      if (!context.directory && !request.projectId) throw new HostRequestError('NO_DIRECTORY', 'Open a project first.');
      const sessionId = `ses_fake${knownSessions.size + 1}`;
      knownSessions.add(sessionId);
      if (request.navigation === 'open') setSession({ id: sessionId, title: request.title, busy: false });
      return { sessionId, sent: request.text ? 'sent' : 'skipped', directory: context.directory ?? '' };
    },
    prompt: async (request) => {
      record('prompt', request);
      if (fake.behavior.prompt) return fake.behavior.prompt(request);
      if (!context.session) throw new HostRequestError('NO_SESSION', 'No open session.');
      if (request.send && context.session.busy) throw new HostRequestError('SESSION_BUSY', 'Session is busy.');
      return { sent: request.send ? 'sent' : 'skipped' };
    },
    compose: async (request) => record('compose', request),
    attach: async (request) => record('attach', request),
    toast: async (request) => record('toast', request),
    openUrl: async (url) => record('openUrl', url),
    writeClipboard: async (text) => record('writeClipboard', text),
    close: async () => record('close'),
    storage: {
      get: async (key) => storage.get(key),
      set: async (key, value) => {
        storage.set(key, value);
      },
      delete: async (key) => {
        storage.delete(key);
      },
      keys: async () => [...storage.keys()].sort(),
    },

    emitReady: (patch = {}) => {
      context = { ...context, ...patch };
      emittedReady = true;
      if (patch.item !== undefined) item = patch.item;
      for (const listener of [...readyListeners]) listener(context);
      return context;
    },
    setSession,
    setDirectory: (directory) => {
      context = { ...context, directory };
      for (const listener of [...directoryListeners]) listener(directory);
    },
    setItem: (next) => {
      item = next;
      context = { ...context, item: next };
      for (const listener of [...itemListeners]) listener(next);
    },
    emitLifecycle: (event) => {
      for (const listener of [...lifecycleListeners]) listener(event);
    },
    emitSessions: (projectId, sessions, state = 'ready') => {
      const snapshot: GuestSessionsSnapshot = { kind: 'sessions', projectId, state, coverage: [], sessions };
      sessionsSnapshots.set(projectId, snapshot);
      for (const listener of [...(sessionsListeners.get(projectId) ?? [])]) listener(snapshot);
    },
    resolver: () => resolver,
    actionHandler: () => actionHandler,
  };
  return fake;
};

export type FakeServices = { host: FakeHost; guestHost: GuestHost; client: ServiceClient; service: FakeService };

/** A fake host + service + the real guest-core wrappers over them. */
export const createFakeServices = (options: FakeHostOptions & FakeServiceOptions = {}): FakeServices => {
  const service = options.service ?? createFakeService(options);
  const host = createFakeHost({ ...options, service });
  const guestHost = createGuestHost(host);
  const client = createServiceClient(host);
  return { host, guestHost, client, service };
};
