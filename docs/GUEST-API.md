# Guest core API (WP4) — reference for the UI (WP5) and integration

Everything in `src/guest/` is framework-free TypeScript. The UI imports these modules and
never talks to `@openchamber/sdk`'s `connectHost()`, `serviceRequest` or `postMessage`
directly. Source of truth: the code; this file is the map. SPEC §8.2 lists the modules; the
signatures below are the final ones.

## Wiring (panel + page entry)

```ts
import { getGuestHost } from '../guest/host.ts';
import { createServiceClient } from '../guest/service-client.ts';
import { createStore } from '../guest/store.ts';
import { createChangeFeed } from '../guest/changes.ts';
import { createFlows } from '../guest/flows.ts';

const host = getGuestHost();                 // the ONE connectHost() of this frame
const client = createServiceClient(host.client);
const store = createStore({ client });
const flows = createFlows({ host, client });
const disconnect = store.connect(createChangeFeed(client));   // live refresh

host.ready.subscribe((ctx) => { if (ctx) applyHostReady(ctx, document.documentElement); });
flows.watchTurns();                                            // every visible frame
flows.watchSessions(() => (store.getState().designs.data?.designs ?? []).map(({ slug, sessionId }) => ({ slug, sessionId })));
flows.watchItems((target) => openDesign(target.slug), showError);   // chip click / Open as artifact
if (surface === 'panel') flows.watchOutbox();                  // rail only (§10.4)
```

UI development without OpenChamber: `const { guestHost: host, client, host: fake, service } =
createFakeServices(); fake.emitReady({ surface: 'page' })` — same wiring, in-memory data.

Errors: every service failure is a `ServiceError { code, message, status }`; flow failures the
user can act on are `FlowError { code, message }`. Both `message`s are user-facing sentences —
show them as is.

---

## `host.ts`

| Export | Signature / meaning |
|---|---|
| `HostLike` | `Pick<HostClient, 'onReady'│'onSession'│'onDirectory'│'onItem'│'onSessionLifecycle'│'onResolve'│'serviceRequest'│'listProjects'│'onSessions'│'openSession'│'openSurface'│'startSession'│'prompt'│'compose'│'attach'│'toast'│'openUrl'│'writeClipboard'│'close'│'storage'>` |
| `Observable<T>` | `{ get(): T; subscribe(fn: (value: T) => void): () => void }` — `subscribe` calls `fn` **now** and on every change |
| `createObservable(initial, equals?)` | `ObservableSource<T>` (= Observable + `set`) |
| `GuestHost` | `{ client: HostLike; ready: Observable<HostReadyContext│null>; session: Observable<SessionSnapshot│null>; directory: Observable<string│null>; item: Observable<GuestItem│null>; onLifecycle(fn): () => void; whenReady(): Promise<HostReadyContext>; dispose() }` |
| `createGuestHost(client: HostLike)` | wraps any HostLike (real or fake) |
| `getGuestHost()` | the frame's singleton over `connectHost()` |

Raw host calls the UI needs (toast, openUrl, writeClipboard, storage `view:<slug>`, close) go
through `host.client.*`.

## `service-client.ts`

| Export | Signature / meaning |
|---|---|
| `ServiceError` | `class extends Error { code: ServiceErrorCode; status: number│null }` |
| `ServiceErrorCode` | `ApiErrorCode │ HostRequestErrorCode │ 'bad-response'` (`NO_SERVICE` = service not approved/running) |
| `isServiceError(e, code?)`, `toServiceError(e)` | narrowing / mapping |
| `ServiceClient.call(key, req?)` | `call<K extends RouteKey>(key: K, ...[{ params, body, query }]) → Promise<RouteResponse<K>>`; `params`/`body` are required exactly when the route has them. E.g. `client.call('GET /designs/:slug', { params: { slug } })` |
| `ServiceClient.loadRender(slug, screen?, version?)` | `→ Promise<RenderDoc>`, `RenderDoc = { meta: RenderMeta; html: string }`; chunks ×3 parallel, one retry on `stale`, LRU 64 MB by render key, concurrent identical loads shared |
| `ServiceClient.upload(text)` | `→ Promise<uploadId>`; F7-safe chunks; `too-large` over 2 000 000 chars |
| `ServiceClient.thumbnail(slug, key?)` | `→ Promise<ThumbnailResponse>`; ready PNGs cached by key |
| `createServiceClient(transport: { serviceRequest }, { renderCacheBytes? })` | |
| `splitUploadChunks(text, maxChars?, maxBytes?)`, `utf8Length(text)` | pure helpers |

## `changes.ts`

| Export | Signature / meaning |
|---|---|
| `createChangeFeed(client, { waitMs?, sleep?, visibility? })` | `ChangeFeed { start(); stop(); subscribe(fn: (b: ChangeBatch) => void); onStatus(fn: (s: FeedStatus) => void); status() }` |
| `ChangeBatch` | `{ reset: boolean; events: ChangeEvent[]; epoch: string; seq: number }` (only non-empty or reset batches are emitted) |
| `FeedStatus` | `{ state: 'connecting'│'live'│'retrying'│'paused'│'stopped'; error: ServiceError│null; retryInMs: number│null }` — use for a "Reconnecting…" hint |
| `nextBackoff(ms)` | 1 → 2 → 4 → 8 → 10 s |

## `store.ts`

`createStore({ client }) → Store`. Read with `getState()` / `subscribe((state, previous) => …)`.

```ts
type LoadStatus = 'idle' | 'loading' | 'ready' | 'error';
type Loadable<T> = { status: LoadStatus; data: T | null /* kept while reloading / after error */; error: ServiceError | null };
type AppState = {
  service: { state: 'unknown' | 'ready' | 'error'; version: string | null; error: ServiceError | null };
  settings: Loadable<SettingsResponse>;
  designs: Loadable<DesignListResponse>;
  presets: Loadable<PresetsResponse>;
  open: (Loadable<DesignDetailResponse> & { slug: string }) | null;
  versions: (Loadable<VersionListResponse> & { slug: string }) | null;
  thumbs: Record<slug, ThumbnailResponse>;
  renderRevs: Record<renderSourceKey, number>; // bumped when that source's files change → reload that artboard
};
```

Loads (result goes to state; never reject): `checkHealth()`, `loadSettings()`, `loadPresets()`,
`refreshDesigns(query?: { q?, kind? })` (query is remembered), `openDesign(slug)`,
`closeDesign()`, `refreshOpenDesign()`, `loadVersions(slug)`, `loadThumbnail(slug) → thumb│null`.

Mutations (reject with `ServiceError`, update state on success): `updateSettings(body)`,
`renameDesign(slug, title)`, `patchDesign(slug, body)`, `deleteDesign(slug) → trashedTo`,
`addComment(slug, { screen, viewport, anchor, body }) → Comment`, `updateComment(slug, id, { body?, status? })`,
`deleteComment(slug, id)`, `snapshotVersion(slug, label?) → VersionSummary│null`,
`restoreVersion(slug, vid)`, `diffVersion(slug, vid, against?)`, `loadRender(slug, screen, version?)`,
`loadSource(slug, screen?)`, `exportDesign(slug, { format, screen? }) → { path, bytes, format }`, `reveal(path)`.

Live: `connect(feed) → disconnect`, `applyChanges(batch)`. Helpers: `renderSourceKey(slug, screen│null)`,
`affectedSources(design, files) → 'all' │ (string│null)[]`, `initialState()`.

## `camera.ts` (pure)

Types: `Camera { x, y, scale }` (screen = world × scale + (x, y)), `Point`, `Size { width, height }`,
`Box { x, y, width, height }`, `WallScreen { id: string│null; title; viewports? }`,
`WallArtboard { id, screen, screenTitle, viewport, row, col, frame: Box, label: Box }`,
`WallLayout { artboards, bounds: Box│null }`.

`DEFAULT_CAMERA`, `ZOOM_STEP` (1.25), `FIT_PADDING` (48), `clampScale(s)` (0.05–4), `clampCamera(c)`
(pan ±1e6), `worldToScreen(c, p)`, `screenToWorld(c, p)`, `zoomAt(c, scale, point)`,
`zoomBy(c, factor, point)`, `wheelZoom(c, deltaY, point)`, `panBy(c, dx, dy)`, `unionBoxes(boxes)`,
`fitBox(box, viewport, { padding?, maxScale? = 1 })`, `fitAll(boxes, viewport, opts?)`,
`focusArtboard(artboard, viewport, opts?)`, `artboardBox(artboard)` (label + frame),
`layoutWall(screens, viewports, { gap? = 96, labelHeight? = 28 })`, `isBoxVisible(c, box, viewport, margin?)`
(frame budget: margin `FRAME_UNLOAD_MARGIN`). Artifact: `layoutWall([{ id: null, title }], viewports)`.

## `frame-doc.ts`

| Export | Meaning |
|---|---|
| `ARTBOARD_SANDBOX` | `'allow-scripts'` — the only sandbox value an artboard iframe may have |
| `createFrameDocument(html, { artboardId, file, mode, scroll?, nonce? }, bridge?)` | `→ FrameDocument { url (blob:), init: BridgeInit, revoke() }` — set `iframe.src = url`; call `revoke()` when the iframe is replaced/removed |
| `injectBridge(html, init, bridge)`, `bridgeScriptTag(init, bridge)`, `bridgeInitOf(init)`, `newNonce()`, `bundledBridge()` | building blocks (tests) |

`file` is the design-relative file (`screens/home.html`, `index.html`); `artboardId` is
`artboardIdOf(screen│null, viewportId)` from `src/shared/bridge-protocol.ts`.

## `frame-channel.ts` (added module — page side of §8.3)

| Export | Meaning |
|---|---|
| `createFrameChannel({ artboardId, nonce, frame: iframe, window? })` | `FrameChannel { identity; send(body: PageMessageBody); subscribe(fn: (m: FrameToPageMessage) => void); dispose() }`. Create it **before** setting `iframe.src`; it answers `ready` with `init-ack` itself. Accepts only `event.source === iframe.contentWindow` + valid shape + same artboardId/nonce |
| `acceptFrameMessage(event, expectedSource, identity)` | the pure validation step |
| `PageMessageBody` | a `PageToFrameMessage` without `dc/artboardId/nonce`, e.g. `{ type: 'hit-test', x, y }` |

Coordinates: `hit-test {x, y}` takes **frame px** (viewport of the design document:
`(clientX − frameLeft) / camera.scale`). Every rect the bridge reports (`hit.element.rect`,
`anchors[].rect`) is **document px** (includes the frame's scroll); `scroll {x, y}` is the frame
scroll. `wheel {x, y}` are frame px.

## `anchoring.ts` (pure + one tracker)

`PinState = 'pending' │ 'exact' │ 'moved' │ 'detached'`;
`PinPlacement { commentId, state, rect (doc px), point (doc px) }`.

`commentsForArtboard(comments, screen│null, viewportId)`, `anchorQueriesOf(comments)`,
`placePins(comments, results│null)`, `pinPoint(rect, rel)`, `isDetached(p)`,
`docToFrame(point, scroll)`, `docToWall(point, scroll, frameBox)` (then `worldToScreen`),
`isInFrameView(point, scroll, frameSize)` (hide pins scrolled out),
`anchorFromHit(hit: HitElement, click: frame px, scroll) → CommentAnchor` (for `addComment`),
`trackPins(channel, comments?) → PinTracker { setComments(c); placements(); scroll(); subscribe((pins, scroll) => …); dispose() }`
— asks `resolve-anchors` on `ready`, on `size`, and when comment ids change.

## `bridge/` (runs inside the design frame; the UI never imports `bridge.ts`)

`selector.ts`: `buildSelector(el, root)`, `segmentOf`, `isUniqueMatch`, `tagNameOf`, `cssString`,
`TEST_ATTRIBUTES`. `anchor.ts`: `resolveAnchor(root, { selector, text, html }) → { found, exact, element }`,
`elementText`, `openingTag`, `normalizeText`, `tagOfSnippet`. `links.ts`: `classifyLink(href, file)`,
`classifyGoto(screenId)` → `LinkAction` (`fragment │ navigate │ external │ blocked`).

Bridge behaviour the UI relies on: Edit mode forwards **every** wheel (`wheel`, preventDefault)
and ctrl/⌘ wheels in Play; `key` for Escape, Space, + = − 0 1 (never from inputs); Play-mode
clicks on links → `navigate { href: 'screens/x.html', hash }` / `open-external { url }`;
`[data-dc-goto]` → `navigate`; forms never submit; `highlight { selector }` draws an outline
inside the frame (`null` clears).

## `flows.ts` (§10)

`createFlows({ host: GuestHost, client, now? }) → Flows`:

| Method | Result |
|---|---|
| `resolveSlashCommand({ command, args })` | `AttachIssueRequest` (background frame) |
| `newDesign({ kind, brief, preset?, destination: 'new-chat'│'current-chat' })` | `{ slug, sessionId│null }`; `FlowError('no-project')` → show "Open a project first, then try again." inline |
| `continueInChat(slug)` | `{ outcome: 'opened'│'new-session', sessionId }` |
| `sendComments(slug, commentIds?)` | `{ outcome: 'sent'│'composed'│'outbox'│'new-session'│'nothing', sessionId, commentIds, omitted }` — `omitted.length > 0` → "K of N sent; send again for the rest". `outbox`: the page is being closed by the host |
| `deliverOutbox(session?)` | `'delivered'│'composed'│'none'` |
| `reconcile(snapshot, designs)` / `planReconciliation(snapshot, designs)` | links patched |
| `snapshotTurn(sessionId)` | `POST /versions/turn`, deduped 2 s |
| `openAsArtifact(item: GuestMessageItem)` | `{ slug }` or `null` (toast "No HTML code block in this message" already shown) |
| `handleItem(item)` | `{ kind: 'open-design', slug }` or `null` |
| `watchTurns()`, `watchOutbox()`, `watchSessions(getDesigns)`, `watchItems(open, onError?)` | each returns its stop function |

Toasts the flows show themselves: busy ("Agent is busy — revision placed in the composer") and
no-HTML. Everything else is returned for the UI to present. Constants: `MESSAGES`,
`PANEL_SURFACE_ID`, `OPEN_AS_ARTIFACT_ACTION`, `CHIP_ID_PREFIX`; helpers `toAttachRequest(chip)`,
`sameDirectory(a, b)`, `isHostError(e, code)`.

## `fake-services.ts` (dev/test only — never imported by a production entry)

`createFakeServices(opts?) → { host: FakeHost; guestHost: GuestHost; client: ServiceClient; service: FakeService }`.
Opts: `surface`, `directory`, `session`, `projects`, `knownSessions`, `renderChunkChars`, `empty`, `service`.
Seed data: canvas `coffee-subscription` (2 screens × laptop/phone, 1 open comment, linked to
`ses_fake_coffee`), artifact `launch-announcement`, pending canvas `onboarding-flow`.

`FakeService`: `handle(request)`, `designs`, `outbox`, `requests`, `emit(slug, kind, files?)`,
`writeFile(slug, file, text)` (simulates the agent; emits `files`). Thumbnails answer
`unavailable` (exercise the live mini-frame path).

`FakeHost` (a `HostLike`): `emitReady(patch?)`, `setSession`, `setDirectory`, `setItem`,
`emitLifecycle`, `emitSessions(projectId, records, state?)`, `calls`, `callsOf(method)`,
`behavior` (override `prompt`/`startSession`/`openSession`/`openSurface`), `knownSessions`,
`projects`, `resolver()`. `createFakeService(opts)`, `createFakeHost(opts)`, `FAKE_THEME_TOKENS`,
`fakeHash` are exported too.

## Deviations from SPEC §8.2 (for the main agent)

1. **Added modules**: `frame-channel.ts` (page-side channel + validation; §8.2 left it implicit),
   `bridge/links.ts`, `fake-services.ts`.
2. **Render docs** are cached by render key inside `service-client.ts`, not in store state; the
   store exposes `renderRevs` (per source) so artboards know when to reload.
3. **Open as artifact** does not run `extractHtml` in the guest (WP3's `html-extract.ts` is not on
   this branch): it uploads the message and relies on `POST /artifacts/from-message` answering
   422 `no-html` (same toast). Integration may add the client-side pre-check to save the upload.
4. **One host connection**: `src/ui/main.ts` must use `getGuestHost()` instead of its own
   `connectHost()` (two connections in one frame would duplicate every host event).
