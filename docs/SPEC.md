# Design Chamber — technical spec

Status: v1 spec, 2026-10-26. Authority for architecture, contracts and lanes (see `AGENTS.md`).
Product decisions live in `docs/BRIEF.md` and are not re-decided here. Every platform claim
cites OpenChamber source at commit `0056bf6a9` (`~/Documents/GitHub/openchamber`, "OC:" below)
or a spike in `spikes/` that was run on this machine (Windows 11, Chrome + Edge, Node 24.21).

---

## 1. Goals and non-goals

**Goals (v1)**
1. One OpenChamber extension (SDK `apiVersion: 1`, OpenChamber ≥ 2.5.0) with a rail **panel**
   (navigator + compact viewer), a full-screen **page** (library, canvas wall, artifact viewer),
   a hidden **background** entry (slash commands), and a local Node **service** (all filesystem,
   rendering, thumbnails, versions, export).
2. Designs are plain folders under a user-changeable root (default `~/Documents/Designs`),
   written by the user's own chat agent. The extension watches and refreshes live.
3. `/design <brief>` and `/artifact <brief>` attach a chip that tells the agent where to write,
   the `design.json` contract and the layered design rules (BRIEF precedence 1–5).
4. In-app rendering of agent-written HTML with its local CSS, images, fonts and inline JS in
   sandboxed nested frames — the same rendering for artifacts and every canvas artboard.
5. Canvas wall: infinite pan both axes, zoom, artboards = screens × viewports, Edit/Play,
   element-anchored comment pins, "send comments" to the linked chat, versions with compare/restore.
6. Artifact viewer: export ZIP and single-file HTML, open in chat, copy.
7. Headless-Chrome PNG thumbnails cached on change; live mini-frame fallback without Chrome.
8. Host theme everywhere (rail + page), following theme changes live.

**Non-goals (v1)** — explicitly out, so no work package builds them:
- No `provides: ["browser"]`, no shared surface, no external Chrome window, no dev server, no
  Vite/React scaffold, no CDP driving (design-canvas architecture is not inherited).
- No quality gates (a11y/overflow/tokens probes from design-canvas `service/gates/`) — needs CDP;
  candidate for v2.
- No PNG/PDF export, no manual artboard dragging (auto-grid only), no multi-user/comments sync.
- No runtime `fetch()`/XHR of local files from inside a design, no ES-module graphs across files,
  no remote assets (CDN scripts, web fonts, remote images): the host CSP blocks them (§4.1).
- No automatic move of designs when the root changes.
- No writes to the user's OpenCode/OpenChamber config.

---

## 2. Platform facts this design rests on (verified)

| # | Fact | Evidence |
|---|---|---|
| F1 | Guest frames are `sandbox="allow-scripts"` (no same-origin, no downloads, no popups). | OC `packages/ui/src/components/layout/PluginPane.tsx:1043` |
| F2 | Every guest document runs under `guestFramePolicy`: `script-src 'unsafe-inline' 'unsafe-eval' 'self' data: blob:`, `img/font/style/media-src 'self' data: blob:`, `frame-src 'self' data: blob:`, `connect-src` = own package path only, `form-action 'none'`. | OC `packages/sdk/src/frame-policy.ts:20-37`; served per file `packages/sdk/DOCUMENTATION.md:91` |
| F3 | Nested `blob:`, `srcdoc` and `data:` frames created by the guest **inherit the guest CSP** and run inline + eval script; they get their own opaque origin. | Spike `spikes/nested-frame/run.mjs`: all three report `inlineScript:true, evalOk:true` and `securitypolicyviolation` `connect-src` for blob/https fetches |
| F4 | A nested frame **cannot load `blob:` URLs created by the guest** (blob store is origin-keyed; no CSP violation is raised). `data:` URLs and blob URLs the nested frame creates itself do load. Relative URLs do not resolve. | Same spike: `blobImg:false, dataImg:true, ownBlobImg:true, relativeImg:false` |
| F5 | A nested frame cannot touch `parent.parent` (host); the host accepts messages only from the guest iframe's own `contentWindow`. | Spike `reachTop:"denied"`; OC `PluginPane.tsx:562` |
| F6 | Desktop refuses navigation of opaque-origin frames except to `about:`/`data:`/`blob:` or guest paths. | OC `packages/electron/guest-frame-navigation.mjs:12,61-72` |
| F7 | `serviceRequest` body (the string) ≤ 64 000 chars, whole JSON ≤ 80 kB; method GET/POST/PUT/PATCH/DELETE; query values ≤ 2 000. | OC `packages/web/server/lib/guests/routes.js:67,87-98` |
| F8 | `serviceRequest` answer is read as **UTF-8 text** ≤ 8 000 000 bytes (`RESPONSE_TOO_LARGE` beyond), 20 s timeout; the host always sends `Content-Type: application/json` for bodies. No binary, no streaming. | OC `server/lib/guests/service.js:715-717,759-781`; `response-body.js:13-36`; `sdk/src/contract.ts:400-403`; `GUEST_SERVICES.md:172` |
| F9 | Service env is an allowlist (PATH, HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP, …); **no `ProgramFiles`, no `ONEDRIVE`, no custom vars**. Panel-driven services are not idle-stopped. | OC `service.js:556-574`; `GUEST_SERVICES.md:149-161` |
| F10 | No guest API to download/save a file or open a native dialog. `toast` has host-owned Copy/OK buttons. `openUrl` is http(s) only. | `sdk/API.md:141-173`, `:293-299` |
| F11 | **A guest cannot open the full-screen page.** Only the sidebar "Extension pages" menu opens it; `openSurface` opens rail surfaces only (`plugin:<panel.id>`). | OC `packages/ui/src/lib/surfaces/DOCUMENTATION.md:13`; `lib/surfaces/modes.ts:16-19`; `lib/guests/open-surface.ts` |
| F12 | `openSession(id)` selects the session and **closes the page**; throws `NO_SESSION` when the session is unknown. | OC `ui/src/lib/guests/workspace.ts:188-193` |
| F13 | `prompt({text, send})` acts on the **currently selected** session of the app; `NO_SESSION` / `SESSION_BUSY`; compose replaces. Text ≤ 16 000. | OC `PluginPane.tsx:184-188,718-731`; `lib/guests/start-session.ts:233-296`; `sdk/DOCUMENTATION.md:57,65` |
| F14 | `startSession` takes the attach fields + `text` (first message) + `projectId` + `navigation`, returns `{ sessionId, … }`; needs `sessions` (+ `prompt` with text). | `sdk/API.md:149,194-198`; `PluginPane.tsx:699-717` |
| F15 | Slash commands: `onResolve({command,args})` → chip `AttachIssueRequest` (`text` ≤ 16 000, `data` ≤ 16 000 serialized, `id` ≤ 128, `title` ≤ 200). With a `background.entry` the hidden background frame answers; the host waits 20 s. | `sdk/DOCUMENTATION.md:53,55,63`; `sdk/API.md:307,375-397` |
| F16 | Session records expose `items: [{ id, data? }]` = **this extension's chips attached to that session** (`id` = chip id). | `sdk/src/workspace.ts:19-34`; OC `ui/src/lib/guests/workspace.ts:65-67` |
| F17 | Message action `where:"message"` delivers `GuestMessageItem { sessionId, directory, messageId, role, text ≤ 200 000 }`; `text` is the Markdown-export rendering (fenced code blocks preserved). Default `open` mode routes to the rail with `ready.item`. | `sdk/API.md:108-131`; OC `ui/src/lib/exportSession.ts:73-75`; `sdk/DOCUMENTATION.md:97` |
| F18 | `onSessionLifecycle` gives `started`/`completed`/`failure` for the frame's session. | `sdk/DOCUMENTATION.md:67` |
| F19 | `ready.theme.tokens` + `applyHostReady` write `--oc-*` CSS variables; `onReady` repeats on theme change. The UI kit look is appended by the server. | `sdk/src/ui/theme.ts:15-41`; `sdk/DOCUMENTATION.md:35,56`; `sdk/API.md:414-426` |
| F20 | `contributes.filesystem` is a static list of globs approved at install — it cannot follow a user-changed root. | `sdk/DOCUMENTATION.md:59` |
| F21 | `host.storage` (instance) 64 KiB/value, 2 MiB/namespace, no capability. | `sdk/API.md:240-244` |
| F22 | One-shot `chrome --headless=new --screenshot --window-size=1280,800 --force-device-scale-factor=0.25 file:///…/index.html` renders local assets + scripts → 320×200 PNG in ~0.9 s (Chrome) / 2.6 s (Edge). No CDP needed. | Spike `spikes/thumbnail/run.mjs` (both browsers, image checked) |
| F23 | Hidden command panes report `surface: 'background'` only when `background.entry` exists. | OC `PluginPane.tsx:294,315` |

---

## 3. Architecture

```
 OpenChamber host (React)                                             user's chat agent
 ┌───────────────────────────────────────────────────────────────┐    (OpenCode session)
 │ rail PluginPane  ── panel ──┐   page PluginPane ── page ──┐   │        │ writes files
 │ (sandbox allow-scripts)     │   (same bundle, surface=page)│   │        ▼
 │  ┌─ dist/panel/main.js ─────┴───────────────────────────────┴─┐ │  ~/Documents/Designs/<slug>/
 │  │ UI (src/ui) ── guest core (src/guest) ── connectHost()      │ │   design.json, index.html |
 │  │   │  design frames: <iframe sandbox=allow-scripts src=blob:>│ │   screens/*.html, assets/,
 │  │   │   = service-inlined HTML + injected bridge (postMessage)│ │   DESIGN.md, tokens.css,
 │  │   └─ serviceRequest (JSON/text, ≤64k up, ≤8MB down)        │ │   .versions/, .chamber/,
 │  └─────────────────────────────────────────────────────────────┘ │   .thumb.png
 │ hidden PluginPane ── dist/background/main.js (onResolve /design) │        ▲
 └──────────────┬────────────────────────────────────────────────┘        │ fs read/write/watch
                │ POST /api/guests/design-chamber/service/request        │
                ▼                                                         │
        host loopback proxy ── Bearer ──▶ dist/service/main.js (Node, 127.0.0.1:port) ─┘
                                           ├ store (design.json merge, .chamber/state.json)
                                           ├ watcher (fs.watch recursive + poll) → change hub
                                           ├ bundler (inline assets as data:) → render cache
                                           ├ versions (content-addressed .versions/)
                                           ├ thumbnails (one-shot headless Chrome/Edge)
                                           ├ export (ZIP / single-file → ~/Downloads)
                                           └ agent instructions (chip + RULES.md from rules/**)
```

Decisions:
- **All filesystem work is in the service** (F20: `filesystem` globs can't follow a changed root;
  F8 the service can read binaries and watch). Guests declare no `files`/`filesystem`.
- **One visible bundle** for panel and page (`ready.surface` switches layout); a separate tiny
  background bundle answers slash commands fast (F15, F23).
- **Rendering = service inlines every local reference as `data:`** (F4), guest wraps the HTML
  in a `blob:` document for a nested sandboxed frame (F3). `blob:` (not `srcdoc`) because a
  `srcdoc` document's base URL is the guest package path, so any un-inlined relative URL would hit
  our own package (`'self'` is allowed for scripts) — a blob document's relative URLs fail closed.
- **Change delivery = long-poll** `GET /changes?since&wait` (no streaming exists, F8).
- **Vanilla TypeScript + `@openchamber/sdk/ui` kit**, no framework (kit is plain DOM; native
  fidelity; small bundle).

---

## 4. Feasibility verdicts

### 4.1 In-app rendering — FEASIBLE (spiked)
- Nested frames: guest creates `<iframe sandbox="allow-scripts">` with `src = URL.createObjectURL(new
  Blob([html], {type:'text/html'}))`. Never add `allow-same-origin`. CSP is inherited (F3), so
  the design's inline `<script>`, event handlers and `eval` run → **Play-mode prototypes and JS
  artifacts work**. `fetch`/XHR/WebSocket from the design are blocked (`connect-src`), remote
  `<script src=https…>` blocked (`script-src` never takes remote origins), remote img/font/css
  blocked unless approved origins (none in v1).
- Assets: because guest blob URLs don't resolve in the child (F4), the **service bundler** produces
  a self-contained HTML string: CSS `<link>`→`<style>` (recursive `@import`/`url()`), `<script
  src>`→inline, images/fonts/media/`srcset`/`poster`/SVG `href`/inline `style` `url()` → `data:`.
  This is the same function as the single-file export (minus the bridge).
- Transport: F8 caps one answer at 8 MB of text → `GET /render` returns metadata + chunk count,
  `GET /render/chunk` returns raw text chunks of ≤ 6 000 000 UTF-8 bytes; the guest concatenates.
  Memory cap per document 60 MB (service refuses larger with `too-large`).
- Limits shown to the user (artboard badge "N blocked"): remote URLs, module imports,
  references escaping the design folder, missing files. Runtime-created relative URLs
  (`new Image().src='assets/x.png'`) don't load — the rules already require static references
  (`rules/DESIGN-RULES.md` §5).
- v2 optimisation if memory hurts (many artboards × big images): bootstrap doc that receives
  `ArrayBuffer`s by `postMessage` and creates its own blob URLs (F4 `ownBlobImg:true`).

### 4.2 Pins and element anchoring — FEASIBLE
Guest injects a **bridge** `<script>` as the first child of `<head>` of every design document.
Page ↔ design frame talk with `postMessage(msg, '*')`; the page accepts only
`event.source === artboardIframe.contentWindow` and validates every message shape (the design is
untrusted and runs in the same realm as the bridge, so bridge messages are *advisory*: they can
only move pins, report sizes, request navigation within the design, or request an external URL
the user then confirms). Protocol in §8.3.

### 4.3 Export delivery — FEASIBLE via service, no download in the frame
F1 (no `allow-downloads`) + F10 (no save API) → the **service writes the file** to
`~/Downloads/<slug>[ (n)].zip|.html` (falls back to `<root>/.exports/` when `~/Downloads` is
missing), answers the path; the guest shows `host.toast({kind:'success', message:'Saved to …',
copy:{text: path}, dismiss:true})` and offers **Show in folder** (service spawns
`explorer.exe /select,<path>` | `open -R <path>` | `xdg-open <dir>`; only for paths it issued).

### 4.4 Thumbnails — FEASIBLE (spiked, simpler than design-canvas)
One-shot CLI (F22), no CDP, queue concurrency 1, 20 s kill timeout, throwaway `--user-data-dir`
in temp, `--host-resolver-rules="MAP * ~NOTFOUND"` so thumbnails match the offline in-app render.
Chrome discovery ported from design-canvas `service/browser.ts:39-59` and extended (§9.6). PNG
cached at `<design>/.thumb.png`, key in `.chamber/thumb.json`; served as base64 JSON → `<img
src="data:image/png;base64,…">` (F2 `img-src data:`). No browser → `unavailable` → live mini-frame.
Captured with `--blink-settings=preferredColorScheme=1` (forced **light**, the scheme the wall's
sandboxed artboards render; headless Chrome otherwise follows the OS dark mode). The scheme is part
of the cache identity in `thumb.json`, so PNGs taken under another scheme are re-taken.

### 4.5 Theme — FEASIBLE
`host.onReady(ctx => applyHostReady(ctx, document.documentElement))` on every snapshot (F19). All
chrome CSS uses `var(--oc-*)` only. The wall background is `--oc-muted-surface`; artboards keep
the design's own colours.

### 4.6 Chat linkage — FEASIBLE with two host constraints
- F11: the page cannot be opened programmatically → items opened from chat (chip click, "Open as
  artifact") open in the **rail viewer**, which is a real (compact) viewer, with a one-line hint
  "Full screen: sidebar → Extension pages → Design Chamber".
- F12/F13: `prompt` targets the selected session and `openSession` closes the page → "send
  comments" to a session that is not selected goes through a service **outbox** delivered by the
  rail panel after `openSession` (§10.4).

### 4.7 Settings — service-owned file (ported `settings.ts`), not `host.storage`
The service must know the root without a frame (watcher, thumbnails). `host.storage` is only for
per-device view prefs (camera per design).

### 4.8 Watching — service `fs.watch(root, {recursive:true})` + 3 s poll backstop, debounce
250 ms, change hub with sequence numbers, guest long-poll (wait 15 s < 20 s host timeout).

### 4.9 Versions — service snapshots on (a) quiet period 8 s after content changes, (b) immediately
on "agent turn completed" reported by any frame (F18), (c) before restore; dedupe by tree hash.

### 4.10 Build — esbuild IIFE (as design-canvas `scripts/build.mjs`), TS strict, `node:test` on
Node ≥ 22.18 type stripping (`.ts` imports, erasable syntax only).

---

## 5. Manifest (`package.json`, owned by the main agent)

```json
{
  "name": "design-chamber",
  "version": "0.1.0",
  "description": "Design Chamber — design canvases and HTML artifacts written by your chat agent, rendered inside OpenChamber.",
  "license": "MIT",
  "private": true,
  "type": "module",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=2.5.0" },
    "contributes": {
      "panel": { "id": "design-chamber", "name": "Design Chamber", "icon": "palette", "entry": "dist/panel/index.html" },
      "page": { "entry": "dist/panel/index.html", "title": "Design Chamber" },
      "background": { "entry": "dist/background/index.html" },
      "commands": [
        { "name": "design", "description": "New design canvas: attach design rules, folder and contract" },
        { "name": "artifact", "description": "New HTML artifact: attach design rules, folder and contract" }
      ],
      "actions": [
        { "id": "open-as-artifact", "label": "Open as artifact", "icon": "palette", "where": "message", "roles": ["assistant"], "mode": "background" }
      ],
      "capabilities": ["prompt", "sessions"],
      "service": {
        "entry": "dist/service/main.js",
        "runtime": "host",
        "permissions": { "exec": ["chrome", "msedge", "chromium", "explorer", "open", "xdg-open"] }
      }
    }
  },
  "scripts": {
    "build": "node scripts/build.mjs",
    "typecheck": "tsc --noEmit",
    "test": "node --test --test-concurrency=1 \"test/**/*.test.ts\"",
    "check": "npm run typecheck && npm run build && npm test",
    "pack": "node scripts/pack.mjs"
  },
  "devDependencies": { "@openchamber/sdk": "2.5.2", "@types/node": "^22.10.0", "esbuild": "^0.24.0", "typescript": "^5.8.0" }
}
```
Notes: `palette` is a Remixicon name (falls back to `apps` if the sprite lacks it,
`sdk/DOCUMENTATION.md:44`). No `attach` key (chip clicks still reopen the rail,
`DOCUMENTATION.md:61`). No `origins` (owner question Q2). `exec` is advisory text for the approval
dialog (`GUEST_SERVICES.md:93`). `dist/` is gitignored; `npm run build` before folder install;
`npm run pack` produces a zip with `package.json`, `dist/`, `rules/`, `LICENSE`, `README.md` for
release (owner-gated). The action is `mode: "background"`, not `"open"`: `open` parks the message for
the rail and calls `openContextSurface`, which **toggles** (it closed an open rail and lost the parked
message), so the hidden background frame handles the action itself (§10.7).

---

## 6. On-disk data contract

### 6.1 Folder layout
```
<root>/                          default ~/Documents/Designs (os.homedir()/Documents/Designs)
  <slug>/                        slug: ^[a-z0-9][a-z0-9-]{0,62}$, unique (suffix -2, -3…)
    design.json                  contract below (agent + service, merged)
    index.html                   artifact entry (kind "artifact")
    screens/<screenId>.html      canvas screens (kind "canvas"); screenId ^[a-z0-9][a-z0-9-]{0,40}$
    assets/**                    images, fonts, scripts, css referenced relatively
    DESIGN.md, tokens.css        per-design design system
    .thumb.png                   thumbnail cache (service)
    .chamber/                    service-owned, never exported/versioned
      state.json                 authoritative service-owned fields (6.3)
      RULES.md                   assembled agent instructions (§11)
      thumb.json                 { key, createdAt, viewport, scheme:"light" }
    .versions/                   snapshots (6.4)
  .trash/<slug>-<yyyymmddhhmmss>/  deleted designs (service moves, never hard-deletes)
  .exports/                       export fallback when ~/Downloads is missing
```
Entries starting with `.` at root level are not designs. **A folder is a design only when it holds
`design.json`, `.chamber/state.json`, an artifact `index.html` or a `screens/` folder**
(`root.ts` `isDesignFolder`); any other folder under the root is the user's own and is never
listed, counted, reconciled, snapshotted, trashed or written into (get/comments/versions/thumbnails
answer `not-found`). A folder without `design.json` but with
`index.html` is listed as an artifact with `warnings:["no-design-json"]` (agent may write HTML
first); the service writes a minimal `design.json` on first service-side mutation.

### 6.2 `design.json` (schema `design-chamber/design@1`)
Field names follow `rules/DESIGN-RULES.md` (`created`/`updated`).
```jsonc
{
  "version": 1,                         // service-owned, const 1
  "kind": "canvas",                     // service-owned at creation: "artifact" | "canvas"
  "title": "Checkout redesign",         // agent; 1..120 chars
  "created": "2026-10-26T18:00:00.000Z",// service-owned
  "updated": "2026-10-26T18:20:00.000Z",// agent (service also bumps on its own writes)
  "brief": "…",                         // service-owned at creation, ≤ 2000
  "sessionId": "ses_…" | null,          // service-owned (linked chat)
  "projectDirectory": "C:\\…" | null,   // service-owned (project the design was started from)
  "preset": "minimal-saas" | null,      // service-owned
  "entry": "index.html",                // artifact only; agent may not change
  "viewports": [                        // agent; 1..8; default laptop+phone
    { "id": "laptop", "label": "Laptop", "width": 1280, "height": 800 },
    { "id": "phone",  "label": "Phone",  "width": 390,  "height": 844 }
  ],
  "screens": [                          // canvas: agent; 0..40, order = wall row order
    { "id": "home", "title": "Home", "file": "screens/home.html",
      "viewports": ["laptop", "phone"], // optional subset; default all
      "description": "…" }              // optional ≤ 500
  ],
  "designSystem": { "confirmed": false },// agent sets true once the user confirms DESIGN.md/tokens.css
  "comments": [ /* Comment, service-owned mirror */ ]
}
```
Validation (`src/shared/design-json.ts`, pure, used by service and tests): unknown keys preserved;
invalid agent fields are dropped with a `warnings[]` entry, never fatal; viewport `width` 200..3840,
`height` 200..4320, ids unique; `screens[].file` must be `screens/<id>.html` (normalised `/`);
artifact `viewports` optional (default `[laptop]`).

`Comment`:
```jsonc
{ "id": "c_8f3k2", "screen": "home" | null /*artifact*/, "viewport": "laptop",
  "anchor": { "selector": "main > section.hero > h1", "text": "Ship faster…" /*≤120*/,
              "html": "<h1 class=\"hero-title\">" /*≤200, opening tag*/,
              "rect": { "x": 120, "y": 340, "w": 600, "h": 64 } /*document px at capture*/,
              "point": { "x": 0.12, "y": 0.5 } /*relative pin offset inside rect*/ },
  "body": "Make this shorter" /*1..2000*/, "status": "open" | "sent" | "resolved",
  "created": "ISO", "sentAt": "ISO" | null, "sentVersion": 12 | null }
```

### 6.3 Ownership and merge (two writers)
Service-owned fields: `version, kind, created, brief, sessionId, projectDirectory, preset, entry,
comments`. Truth is `.chamber/state.json` (`{version:1, ...thoseFields}`); `design.json` carries a
mirror (BRIEF requires comments in design.json). On every watcher event for `design.json` the
service re-reads it; if any service-owned field differs from state.json it rewrites design.json
with state's values merged in (atomic tmp+rename, preserves agent fields and unknown keys, skips
the rewrite if bytes are equal → no watch loop). Service writes update state.json first, then the
mirror. Agent-owned fields are read from design.json only.

### 6.4 `.versions/`
```
.versions/index.json   { "version":1, "next":13, "versions":[VersionEntry…] }  newest last
.versions/objects/<aa>/<sha256>   raw file bytes, content-addressed
```
`VersionEntry = { id:"v12", n:12, created:ISO, reason:"auto"|"turn"|"restore-point"|"restored",
sessionId:string|null, treeHash:sha256, files:{ "<relPath>": "<sha256>" }, bytes:number,
label?:string }`. Tracked set: every file under the design folder except `.versions/**`,
`.chamber/**`, `.thumb.png`, and `design.json` is stored with `comments` removed. Caps: 1 000
files / 100 MB per snapshot (skip + `warnings` beyond), keep newest 100 versions, GC unreferenced
objects after pruning. Restore (§9.5) writes tracked files back and deletes tracked files absent
from the version; never touches `.chamber/`, comments, or `sessionId`. Pruning never removes the
version a restore is writing (`keep`), and a restore whose current tree cannot be stored as a
restore point (over the caps) is refused with 422 `invalid` before anything is written (§9.5).

### 6.5 Settings file (service)
Path (ported from design-canvas `service/settings.ts:33-49`, renamed): win32
`%APPDATA%\Design Chamber\settings.json`; darwin `~/Library/Application Support/Design
Chamber/settings.json`; else `${XDG_CONFIG_HOME:-~/.config}/design-chamber/settings.json`. Test
seam: `DC_SETTINGS_PATH` (tests only — host never passes custom env, F9).
`{ "version":1, "root"?: string, "previousRoots"?: string[] (≤10, newest first),
"chromePath"?: string, "downloadsDir"?: string }`. Corrupt → treated as absent + logged; atomic writes.

---

## 7. Service HTTP API

Conventions: every request needs `Authorization: Bearer $OPENCHAMBER_SERVICE_TOKEN`
(constant-time compare) else 401; bind `127.0.0.1:$OPENCHAMBER_SERVICE_PORT`. JSON in/out unless
stated. Errors: `{ "error": "<code>", "message": "<user-facing sentence>" }` with 400 (`bad-request`,
`bad-path`, `bad-slug`), 404 (`not-found`), 409 (`conflict`, `stale`), 413 (`too-large`), 422
(`no-html`, `invalid`), 500 (`internal`). Request bodies ≤ 64 000 chars (F7); responses ≤ 7 500 000
bytes (headroom under F8). Each handler finishes < 15 s (host timeout 20 s); longer work is a job
polled by the guest. `slug` path params are validated by regex **and** containment (§9.1).
Types for every route live in `src/shared/api.ts` (WP0).

| Method & path | Request | Response | Owner |
|---|---|---|---|
| `GET /health` | — | `{ ok:true, version, epoch }` | WP0 |
| `GET /settings` | — | `{ root, defaultRoot, previousRoots, rootExists, chrome:{ path\|null, source:"setting"\|"detected"\|"none" }, downloadsDir }` | WP1 |
| `PUT /settings` | `{ root?: string\|null, chromePath?: string\|null }` (`null` = default) | same as GET; 400 `bad-path` (relative, drive/filesystem root, the user's home, any ancestor of home, `Documents` itself, inside the extension package, not creatable — §9.2; the message is a sentence, never a raw Node error) | WP1 |
| `GET /changes?since=<seq>&epoch=<e>&wait=<ms≤15000>` | — | `{ epoch, seq, reset:boolean, events:[{ seq, slug\|null, kind:"added"\|"removed"\|"design"\|"files"\|"thumb"\|"versions"\|"comments"\|"root", files?:string[] }] }`; `reset:true` when epoch differs or `since` fell out of the 500-event ring → client refetches all | WP1 |
| `GET /designs` | `?q=&kind=` | `{ root, designs: DesignSummary[] }` (`slug, kind, title, created, updated, pending:boolean, screenCount, viewports, sessionId, openComments, thumb:{ state, key }, warnings`) | WP1 |
| `POST /designs` | `{ kind, title?, brief?, preset?, projectDirectory?, sessionId?, html? (artifact only, ≤ 60k; else uploadId) , uploadId? }` | `{ slug, path, design }` — creates folder, state.json, design.json, `.chamber/RULES.md` (via WP3 hook) | WP1 |
| `GET /designs/:slug` | — | `{ slug, path, design: DesignJson, pending, files:{ entry?:{exists,size}, screens:{[id]:{exists,size,mtime}} }, warnings }` | WP1 |
| `PATCH /designs/:slug` | `{ title?, sessionId?: string\|null, projectDirectory?: string\|null }` | `{ design }` (`title` writes design.json title — user rename) | WP1 |
| `DELETE /designs/:slug` | — | `{ trashedTo }` (moves to `.trash/`) | WP1 |
| `POST /designs/:slug/comments` | `{ screen, viewport, anchor, body }` | `{ comment }` | WP1 |
| `PATCH /designs/:slug/comments/:id` | `{ body?, status? }` | `{ comment }` | WP1 |
| `DELETE /designs/:slug/comments/:id` | — | `{ ok:true }` | WP1 |
| `POST /designs/:slug/comments/mark-sent` | `{ ids, version\|null }` | `{ comments }` | WP1 |
| `POST /uploads` | `{ total: number(≤ 2 000 000) }` | `{ uploadId }` (TTL 10 min, ≤ 8 open) | WP1 |
| `PUT /uploads/:id/:index` | `{ data: string }` (each ≤ 60 000 chars stringified) | `{ received }` | WP1 |
| `GET /outbox` / `PUT /outbox` / `DELETE /outbox` | PUT `{ sessionId, slug, text, commentIds, version }` | `{ outbox \| null }` (one slot, TTL 10 min, in memory) | WP1 |
| `GET /designs/:slug/render?screen=<id>&version=<vid>` | — | `{ key, chunks, bytes, title, missing:string[], blocked:string[], external:string[], warnings }` (builds + caches; 413 `too-large` > 60 MB) | WP2 |
| `GET /designs/:slug/render/chunk?key=&n=` | — | **raw text** chunk n (≤ 6 000 000 UTF-8 bytes); 409 `stale` if key evicted | WP2 |
| `GET /designs/:slug/source?screen=` | — | `{ text, bytes }` raw entry HTML (≤ 2 000 000 chars, for Copy) | WP2 |
| `GET /designs/:slug/thumbnail` | — | `{ state:"ready"\|"pending"\|"unavailable"\|"failed", key, png?: base64, width?, height?, message? }` | WP2 |
| `POST /designs/:slug/thumbnail/refresh` | — | `{ state }` | WP2 |
| `GET /designs/:slug/versions` | — | `{ versions: VersionEntry[] (without files), currentTreeHash, dirty:boolean }` | WP2 |
| `POST /designs/:slug/versions` | `{ reason:"turn"\|"manual", sessionId? }` | `{ created: VersionEntry\|null }` (null = no change) | WP2 |
| `POST /versions/turn` | `{ sessionId }` | `{ created: { slug, id }[] }` — snapshots every design linked to that session with changes | WP2 |
| `GET /designs/:slug/versions/:vid/diff?against=current\|<vid>` | — | `{ files:[{ path, change:"added"\|"removed"\|"modified" }] }` | WP2 |
| `POST /designs/:slug/versions/:vid/restore` | — | `{ restorePoint: VersionEntry\|null, restored: VersionEntry }` | WP2 |
| `POST /designs/:slug/export` | `{ format:"zip"\|"html", screen?: id }` | `{ path, bytes, format }` | WP2 |
| `POST /reveal` | `{ path }` (must be an export path issued this run, or a design folder) | `{ ok:true }` | WP2 |
| `GET /presets` | — | `{ presets:[{ id, name, bestFor }] }` (parsed from `rules/presets/*.md`) | WP3 |
| `POST /chip` | `{ kind:"canvas"\|"artifact", brief, preset?, projectDirectory?, sessionId? }` (`sessionId` validated, not stored — §10.1) | `{ slug, chip: { providerId:"design-chamber", id:"design:<slug>", title, url, text, data:{ slug, kind } } }` — creates the design (pending) + RULES.md | WP3 |
| `POST /designs/:slug/prompt` | `{ purpose:"revision"\|"continue", commentIds?, anchorStates? }` — `anchorStates` is optional `{ [commentId]: "exact"\|"moved"\|"detached" }` from the page\'s pin placement | `{ text, commentIds, omitted, chip }` — revision text ≤ 16 000 (§11.4); `chip` = context chip for `startSession` | WP3 |
| `POST /artifacts/from-message` | `{ uploadId, sessionId, sessionTitle, messageId, directory, open?: boolean }` — `open:true` leaves an open request for the rail | `{ slug, title }` or 422 `no-html` | WP3 |
| `DELETE /open-request` | — | `{ request: { slug, created } \| null }` — takes the single open-request slot exactly once; a newer request replaces an untaken older one; expires after `OPEN_REQUEST_TTL_MS` (2 min); in memory | WP3 |

`DesignSummary.pending` = no entry/screen file exists yet. Thumbnail `key` = sha256 of the render
inputs; the guest caches thumbnails by key in memory.

---

## 8. Guest architecture

### 8.1 Entries
- `dist/panel/index.html` → `dist/panel/main.js` (src `src/ui/main.ts`): `connectHost()`, apply
  theme, route by `ready.surface` (`panel` → rail app, `page` → page app). Never registers
  `onResolve`.
- `dist/background/index.html` → `dist/background/main.js` (src `src/guest/background-main.ts`):
  registers `host.onResolve` synchronously; calls `POST /chip`; returns the chip. No DOM.

### 8.2 Guest core modules (`src/guest/`, non-visual, framework-free)
- `host.ts` — single `HostClient`, ready/theme/session/item/lifecycle observables.
- `service-client.ts` — typed `call<Route>()` over `serviceRequest` (parses JSON, maps errors to
  `ServiceError{code,message}`), `loadRender(slug, screen, version)` (meta + parallel chunk fetch,
  concurrency 3, retries once on `stale`; render docs are cached here by render key, LRU), `upload(text)` (chunker respecting F7: chunk ≤ 60 000
  chars after `JSON.stringify`, ≤ 75 000 UTF-8 bytes), thumbnail cache by key.
- `changes.ts` — one long-poll loop per frame (`wait=15000`, backoff 1→10 s on errors, stop on
  dispose/hidden), emits typed events.
- `store.ts` — app state (designs list, open design, `renderRevs` per render source, comments,
  versions, settings, service status) with subscribe; UI reads only through it. Render docs live in
  `service-client`'s cache, not the store; an artboard reloads when its `renderRevs` entry bumps.
- `camera.ts` — pure wall math ported from design-canvas
  `viewer-client/src/canvas-controller.js:881-892,1063` (`zoomTo` around a point, wheel zoom
  `scale *= exp(-deltaY*0.005)`, pan by deltas) + `fitAll`, `focusArtboard`, clamps scale
  0.05–4 and pan ±1e6; `layoutWall(screens, viewports, gap)` → artboard rects (rows = screens,
  columns = viewports, column width = max viewport width in that column, gap 96 px, label 28 px).
- `frame-doc.ts` — builds the artboard document: `BRIDGE_PLACEHOLDER` (exported by
  `src/shared/bridge-protocol.ts`; the service bundler emits it in render mode) is replaced in place by
  `injectBridge` with the bridge `<script>` (built separately, §12; slice, not `String.replace`, so `$`
  stays verbatim), falling back to a `<head>` search; plus `window.__DC={artboardId, file, mode, scroll, nonce}` at the start of `<head>` (creates
  `<head>` if absent), returns blob URL; revokes on unload.
- `frame-channel.ts` — page side of the bridge: accepts only `event.source === contentWindow` with
  the document nonce and validates message shapes.
- `bridge/` — the injected script (§8.3) and its pure helpers (`selector.ts`, `anchor.ts`,
  `links.ts` — play-mode link classification).
- `fake-services.ts` — `createFakeServices()` for UI development and tests.
- `anchoring.ts` — page-side pin placement from bridge reports; detached detection.
- `flows.ts` — chat flows (§10): new design, continue in chat, send comments, open-as-artifact,
  outbox delivery, session reconciliation, turn snapshots.
- `html-extract.ts` lives in `src/shared/agent/` (WP3) and is imported here.

### 8.3 Bridge protocol (`src/shared/bridge-protocol.ts`, WP0)
Envelope `{ dc: 1, type, artboardId, ... }`. Page → frame:
`init-ack`, `set-mode {mode:"edit"|"play"}`, `hit-test {x,y}` (frame px), `resolve-anchors
{anchors:[{id, selector, text, html}]}`, `scroll-by {dx,dy}`, `scroll-to {x,y}`,
`highlight {selector|null}`.
Frame → page: `ready {docWidth, docHeight, title}`, `size {docWidth, docHeight}` (ResizeObserver,
throttled 100 ms), `scroll {x,y}` (rAF-throttled), `hit {selector, text, html, rect, tag}`,
`anchors {results:[{id, found:boolean, rect|null, exact:boolean}]}`, `navigate {href}` (resolved
design-relative path, e.g. `screens/checkout.html`, plus `hash`), `open-external {url}`,
`wheel {deltaX, deltaY, x, y, ctrl:boolean}` (only ctrl/meta wheel and Edit-mode wheel are
forwarded), `key {key, ctrl, meta, shift}` (only Escape, Space, +, −, 0, 1 for wall shortcuts).
Bridge behaviour:
- Edit mode: the artboard `<iframe>` has `pointer-events:none`; the page owns pointer input and
  asks `hit-test` on hover (rAF) and click; bridge answers with `document.elementFromPoint`.
  Wheel over an artboard in Edit mode scrolls that artboard (`scroll-by`) unless Ctrl/Meta (zoom)
  or Space/middle-drag/pan tool (pan) — design-canvas B3 behaviour.
- Play mode: frame receives input. Bridge intercepts `click` on `a[href]` (capture phase):
  `#frag` → `scrollIntoView`; relative `*.html` resolved against a virtual
  `https://design.invalid/<file>` → `navigate` (page swaps that artboard's document to the target
  screen if it is a known screen/entry, else toast "Not a screen of this design"); `http(s):` →
  `open-external` (page shows confirm, then `host.openUrl`); everything else prevented. Also
  `[data-dc-goto="<screenId>"]` elements navigate. `submit` events are prevented (CSP
  `form-action 'none'` would block them anyway) and logged in the artboard status.
- Selector generation (`selector.ts`, pure over a minimal `El` interface): `#id` if unique →
  `[data-testid|data-screen|data-dc-id]` if unique → tag + stable classes (drop classes matching
  `/^(is-|has-|js-|active|hover|focus)/`) + `:nth-of-type()` chain up to 6 levels or a unique
  ancestor id; verified unique with `querySelectorAll`. Anchor resolution: selector match with same
  tag → `exact`; else search same-tag elements whose normalised text starts with the stored text
  (≥ 12 chars) → `found, exact:false`; else `found:false` → pin is **detached**.

### 8.4 Per-frame budget
Max 12 live artboard frames per page (rail: 4); off-screen artboards (outside viewport + 50%)
beyond the budget are unloaded to a placeholder (title + spinner/thumbnail). Render docs are cached
by render key (LRU 64 MB of strings).

---

## 9. Service modules (`src/service/`)

### 9.1 Paths and containment (`paths.ts`, WP1) — the one tested containment function
`resolveInside(root, ...segments): string` — rejects absolute segments, NUL, `..` segments,
drive letters, UNC prefixes; `path.resolve`; then `fs.realpath` of the deepest existing ancestor;
compares with `path.relative(realRoot, real)`: inside iff not `''`-escaping (no leading `..`, not
absolute). On win32 compare case-insensitively (`toLowerCase()` of both normalised paths). Used
for every path from a request, every reference the bundler resolves, every export/reveal path.
`isStrictlyInside(root, target)` is the disk-free core (lexical, win32 case-insensitive); the
bundler and version restore use these two, no other containment code exists.
`replaceFileIfUnchanged(file, expected, data)` — tmp write, then a synchronous compare + rename only
while the file still holds `expected` (false otherwise; Windows `EPERM`/`EBUSY`/`EACCES` on the
rename counts as "not yet"): the primitive of the design.json two-writer merge (§6.3, §9.3).
`isSlug`, `slugify(title)` (NFKD, ASCII fold, kebab, ≤ 48 chars cut at a word boundary — hard cut only
when the first word alone is longer — fallback `design`; a Windows device
name — `con nul aux prn com1-9 lpt1-9` — becomes `<name>-design`), `uniqueSlug`.

### 9.2 Settings and root (`settings.ts`, `root.ts`, WP1)
Port design-canvas `service/settings.ts` (read/parse/write, previousRoots cap 10) and the root
probe idea from `service/workspace-root.ts` simplified: default root `path.join(os.homedir(),
'Documents', 'Designs')` (BRIEF). Changing root: validate, `mkdir -p`, push old root to
`previousRoots`, restart watcher, emit `root` event; **never moves files**. The rail/page show
"N designs remain in <old root>" with *Switch back*. Counts (`countDesigns`) include only design
folders (§6.1). Every folder under the root is scanned and may become a design, so a candidate root is
**refused** (400 `bad-path`, "That folder holds your own files…") when it is the user's home, any
ancestor of home, or `<home>/Documents` itself; a drive/filesystem root, the extension package and a
non-writable path are refused as before. `Documents\Designs` is accepted. Create/write failures are
reported as one sentence picked by the Node error code (`folderErrorSentence`: ENOENT, EACCES/EPERM,
ENOTDIR/EEXIST, EROFS, ENOSPC, EBUSY, ENAMETOOLONG, EINVAL, EIO…), never the raw message.

### 9.3 Store (`store.ts`, WP1)
List = readdir(root) → for each non-dot dir that `isDesignFolder` (§6.1; the rest are skipped): read
design.json (tolerant), stat entry/screens, state.json; summary cached by mtimes.
`store.dir(slug)` applies the same gate, so every per-design route answers `not-found` for a
non-design folder. The design.json mirror write uses `replaceFileIfUnchanged`: it replaces the file
only while it still holds the text it merged from, else re-reads and re-merges (5 attempts, growing
25 ms pauses), then leaves the agent's file alone (`store.design-json-busy`; state.json keeps the
truth and the next reconcile merges). The create lock key is `'\0create'` (never a slug). Create = mkdir slug, write state.json, design.json,
optional `index.html` from `html`/upload, call `hooks.onCreate(slug)` (WP3 writes RULES.md).
Merge rule §6.3. Delete = rename to `.trash/`. All writes tmp+rename.

### 9.4 Watcher and change hub (`watch.ts`, `changes.ts`, WP1)
Generalises design-canvas `service/screens-watch.ts` (watch fast path + poll backstop + debounce):
`fs.watch(root, { recursive:true, persistent:false })`; events mapped to `{slug, files}`;
ignore `.versions/`, `.chamber/`, `.thumb.png`, tmp files; poll every 3 s (stat design.json,
entry, `screens/` and `assets/` dir mtimes — cheap) because OneDrive/network roots drop events.
Debounce 250 ms per slug. Hub: in-memory ring of 500 events, `seq` monotonic, `epoch` random per
process; `waitFor(since, ms)`. Hub listeners: render cache invalidation, thumbnails, versions,
design.json merge.

### 9.5 Rendering, versions, export, thumbnails (WP2)
- `bundle.ts` — `bundleDocument(source: FileSource, entryRel, opts) → { html, refs, missing,
  blocked, external, warnings }`. `FileSource` reads either the live folder or a version tree
  (objects). Tolerant tag/attribute tokenizer (no HTML library): handles `src`, `href` on
  `link[rel~=stylesheet|icon|preload|modulepreload]`, `srcset`, `poster`, `data` on `<object>`
  (blocked by CSP → reported), SVG `href`/`xlink:href`, `style=""` and `<style>` `url()` and
  `@import`; CSS processed recursively relative to the CSS file (cycle guard, depth 8); `<script
  src>` inlined with `</script` escaped; `type=module` scripts with relative `import` →
  `warnings`. Mime by extension table (png, jpg, jpeg, gif, webp, avif, svg, ico, woff, woff2, ttf,
  otf, mp4, webm, mp3, wav, json, css, js). Every resolved reference goes through
  `resolveInside(designDir, …)`; outside → `blocked`. Remote/`//` URLs untouched → `external`.
  Caps: 500 refs, 60 MB output.
- `render-cache.ts` — key = sha256(entry path + version id + each input's size+mtime or object
  hash); LRU 256 MB; chunking per §7; invalidated by hub events.
- `versions.ts` — tree hash over the tracked set; auto snapshot after 8 s quiet following
  content events; `turn` flushes immediately; restore = snapshot current as `restore-point`
  (`keep: target.id` so pruning at 100 versions never drops, and GC never frees, the version being
  restored; `required: true` so an over-cap tree throws 422 `invalid` — "too large to keep a restore
  point … Nothing was changed" — before any write), write files, delete extra tracked files, snapshot
  as `restored`; emits `versions` + `files` events. A `turn` snapshot whose tree equals the latest
  version is normally deduped, **except** that when that latest version is an `auto` one younger than
  `TURN_PROMOTE_AUTO_MS` (30 min) it is relabelled `turn` ("After agent turn", `sessionId` set) and a
  `versions` event emitted — the quiet-period auto snapshot usually lands before the turn ends.
- `zip.ts` — minimal writer (local headers + central directory, deflate via `zlib.deflateRawSync`,
  CRC-32 table; no zip64; UTF-8 names flag) — new code, no dependency.
- `export.ts` — ZIP: `<slug>/` tree of all tracked files except `design.json` (internal) — html,
  screens, assets, `DESIGN.md`, `tokens.css`. Single-file HTML: `bundleDocument` output without the
  bridge (artifact: `index.html`; canvas: the chosen `screen`, default first). Destination
  `settings.downloadsDir ?? ~/Downloads`, name `<slug>.zip` / `<slug>[-<screen>].html` with
  ` (2)`… on collision; fallback `<root>/.exports/`.
- `reveal.ts` — `explorer.exe /select,"<path>"` (win32), `open -R` (darwin), `xdg-open <dir>`;
  `spawn` with `detached, stdio:'ignore'`, args array (no shell).
- `chrome.ts` — `resolveBrowser(settings)`: `settings.chromePath` if it exists; win32 probes
  `C:\Program Files\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Google\Chrome\…`,
  `%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`, `C:\Program Files (x86)\Microsoft\Edge\
  Application\msedge.exe`, `C:\Program Files\Microsoft\Edge\Application\msedge.exe` (literal paths
  — `ProgramFiles` isn't in the env, F9); darwin `/Applications/Google Chrome.app/…`, `Chromium`,
  `Microsoft Edge`; linux first of `google-chrome`, `google-chrome-stable`, `chromium`,
  `chromium-browser`, `microsoft-edge` on PATH. Ported from design-canvas `service/browser.ts:39-59`.
- `thumbnails.ts` — queue (concurrency 1, newest-first, dedupe by slug), args exactly as spike
  `spikes/thumbnail/run.mjs` plus `--host-resolver-rules="MAP * ~NOTFOUND"`; viewport = first
  viewport of the design (artifact: its viewport or laptop) with scale factor `320 / width` and
`--blink-settings=preferredColorScheme=1` (light, §4.4); source
  = artifact entry or the first screen with an existing file; key = render key; write
  `.thumb.png` atomically; 20 s kill; failure → `failed` with message; re-run on content events
  (debounced 2 s). Thumbnails render `file://` directly (Chrome resolves relative assets itself).

### 9.6 Agent instructions (WP3) — see §11.

### 9.7 Composition (`compose.ts`, `main.ts`, `http.ts`, `context.ts`)
`compose.ts` `composeService` is the composition root: it builds settings, hub, store, uploads,
outbox, render/versions, thumbnails and the watcher into one `ServiceContext` and registers every
lane's routes; `main.ts` only reads env and serves it. `http.ts`: tiny router (`method`, path pattern with `:params`), JSON body parse with 80 kB cap,
error mapping, bearer check, `/health`. `context.ts`: `ServiceContext { packageRoot, settings:
SettingsStore, store: DesignStore, hub: ChangeHub, renders, log }` interfaces. `composeService` calls
`registerXRoutes(router, ctx)` from each lane's `routes/*.ts`. `packageRoot` = two levels above
`dist/service/main.js` (`rules/` is read from there at runtime, so rules edits need no rebuild).

---

## 10. Chat linkage flows (`src/guest/flows.ts`, WP4)

Chip identity: `id = "design:<slug>"`, `providerId = "design-chamber"`, `url =
pathToFileURL(designPath)` (≤ 2 000, else `""`), `data = { slug, kind }`.

### 10.1 `/design <brief>` and `/artifact <brief>` (background frame)
`onResolve({command,args})` → `POST /chip { kind: command==="design"?"canvas":"artifact", brief:
args, projectDirectory: ready.directory, sessionId: ready.session?.id }` → return `chip`. The
service creates the design immediately (`pending`), so it appears in the list. `sessionId` is not
written yet (the user may never send); linking happens by reconciliation (10.5). Errors are thrown
with the service's message (host shows it, F15). Budget: chip build < 3 s (discovery capped).

### 10.2 New design from the extension (rail/page "New" dialog)
Fields: kind, brief, preset (from `GET /presets`, default "None — let the agent propose"),
destination: **New chat** (default) | **Current chat**.
- New chat: `POST /chip` → `host.startSession({ ...chip, text: <brief or "Let's start this
  design.">, navigation:"open" })` → `PATCH sessionId` with the returned id (certain link).
  Needs a project directory (F14); without one → inline error "Open a project first".
- Current chat: `host.attach(chip)` + `host.compose({ text: brief, mode:"append" })`; on the
  page also `host.close()` so the chat is visible.

### 10.3 Continue in chat
`design.sessionId` → `host.openSession(id)`; on `NO_SESSION` or missing → `POST
/designs/:slug/prompt {purpose:"continue"}` → `startSession({ ...chip, navigation:"open" })` in
the project from `design.projectDirectory` (matched via `listProjects`) or the current directory →
`PATCH sessionId`.

### 10.4 Send comments (one revision request)
`POST /designs/:slug/prompt {purpose:"revision"}` → `{ text, commentIds }`. Then:
1. If `ready.session?.id === design.sessionId`: `prompt({text, send: !busy})`; busy → compose +
   toast "Agent is busy — revision placed in the composer".
2. Else if `design.sessionId`: `PUT /outbox {…}`; `openSurface('plugin:design-chamber')` (ignore
   failure); `openSession(design.sessionId)` (closes the page, F12). The rail panel, on
   `onSession` where `session.id === outbox.sessionId`, takes the outbox (`DELETE /outbox` first,
   exactly-once), then step 1. A rail mounted later delivers an outbox < 10 min old.
3. No/gone session: `startSession({ ...chip, text, navigation:"open" })` → `PATCH sessionId`.
On `sent === "sent"` (or composed): `POST comments/mark-sent {ids, version: latest n}`. Once the chat
has the revision, mark-sent is retried once and a persistent failure is **never** thrown (a
rejection would invite a duplicate send): the result is still `sent` with `markFailed:true`, and the
drawer/rail says "Sent — but the comments could not be marked as sent. Resolve them by hand…".

### 10.5 Session reconciliation (rail + page, on mount and on session snapshot changes)
`listProjects` → project for the current directory → `onSessions(projectId)` (1 subscription).
For each session record, items with `id` `design:<slug>`: if that design's `sessionId` is null, or
its session is not in any loaded snapshot with `state:"ready"`, `PATCH sessionId` to the newest
such session (by `updatedAt`). Uses F16.

### 10.6 Turn snapshots
Two sources, both → `POST /versions/turn {sessionId}` (deduped per sessionId per 2 s across rail+page
via the service being idempotent on unchanged trees):
1. `onSessionLifecycle({sessionId, phase:"completed"})` in a visible frame — but the host also reports
   `completed` for any idle chat the frame shows (mount, chat switch), so `completed` counts only
   after a `started` for that session seen by the same frame (`watchTurns`).
2. Linked chats that are **not selected** (F18 covers only the frame's own session): on each
   `onSessions(projectId)` snapshot (§10.5), a session linked to a design whose `activity` went from
   working (`running`, `retrying`, `waiting-permission`, `waiting-question`) to `idle` since the
   previous snapshot gets its turn snapshot (`finishedTurns`, `watchSessions`).
Quiet-period auto snapshots (§4.9) cover a turn snapshot that failed; a turn whose files an `auto`
version already holds relabels it (§9.5).

### 10.7 Open as artifact (message action)
The action is `mode:"background"` (§5): the hidden **background frame** receives it via `onAction`
(`flows.runAction`, `isGuestMessageItem(item) && item.action === "open-as-artifact"`) →
`extractHtml(item.text)` (WP3, pure): fenced blocks with info string `html`
or `htm`, else any fenced block whose content starts with `<!doctype html` or contains `<html` /
`<body`; choose the longest; none → toast "No HTML code block in this message". Upload via chunker
→ `POST /artifacts/from-message {uploadId, sessionId: item.sessionId, …}` → service creates an
artifact with `sessionId` = the message's session, title from `<title>` or first heading in the
message, `index.html` = the block. With `open:true` the service also leaves the open request (§7
`DELETE /open-request`). The background frame then calls `openSurface('plugin:design-chamber')`
(opens, never toggles) and shows a host toast "Saved as artifact “<title>”." — or "…open Design
Chamber to see it." when there is no side panel. The rail takes the request on mount and again on
every `added` change (it may already be open; `flows.watchOpenRequests`) and opens that artifact's
viewer; a lost request only skips the jump. Remote script/style references
are kept and reported (`external`), shown as a banner with **Ask agent to make it
self-contained** (compose/prompt to the linked session).

### 10.8 Chip click
`ready.item` is our attach chip (`isGuestAttachItem`, `data.slug`) → rail opens that design.

---

## 11. Agent instruction assembly (WP3, `src/shared/agent/**`, `src/service/discovery.ts`)

The chip text is capped at 16 000 chars (F15); `rules/DESIGN-RULES.md` (11.5 k) +
`rules/QUESTIONS.md` (4.3 k) + a preset (~1.6 k) already exceed it. So the chip carries a compact
**core** (target ≤ 5 000, hard cap asserted in tests ≤ 15 000) and the service writes the full
assembled instructions to `<design>/.chamber/RULES.md`, which the core makes mandatory reading.
Both live in the design folder, so the agent touches one external directory.

### 11.1 Project-rules discovery (`discovery.ts`, given `projectDirectory`)
Scan depth ≤ 4, skip `node_modules .git dist build out .next coverage vendor .venv`, ≤ 3 000
entries, ≤ 1.5 s; record `{ path (relative), kind, why }`, max 20, in this priority:
1. Design docs: `DESIGN.md`, `design.md`, `docs/DESIGN.md`, `docs/design*.md`, `design/*.md`,
   `STYLEGUIDE.md`, `BRAND*.md`, `docs/brand*.md` (case-insensitive).
2. Tokens/theme: `tokens.css`, `*tokens*.json`, `design-tokens.*`, `theme.{css,ts,js,json}`,
   `tailwind.config.{js,cjs,mjs,ts}`, CSS files containing `@theme` or a `:root{` block with ≥ 5
   `--` custom properties (`globals.css`, `variables.css`, `_variables.scss`).
3. Agent files with design sections: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`,
   `.cursor/rules/*` — included only with a heading matching
   `/design|ui|ux|style|brand|theme|visual|typography|colou?r/i`; record those headings.
4. Breakpoints: Tailwind `screens` keys/values (regex), and the 4 most frequent
   `@media (min|max-width: Npx)` values across scanned CSS → viewport suggestions
   (≤ 480 → phone, ≤ 1024 → tablet, else laptop/desktop).
Only paths and headings go into instructions — the agent reads the files itself (it is in the
project). No project → "no project open".

### 11.2 `RULES.md` assembly order (written at creation and refreshed on every `/prompt` call)
1. Header: design title, kind, absolute folder, absolute file map, "this file is part of your
   instructions".
2. Precedence (BRIEF 1–5) with the concrete layer contents: user's words · project sources list
   (11.1) or "none found" · preset name + `rules/presets/<id>.md` content inlined · per-design
   `DESIGN.md`/`tokens.css` status (`designSystem.confirmed`) · built-in rules.
3. Viewports: project-derived suggestions, else defaults Laptop 1280×800 + Phone 390×844, with the
   instruction to confirm with the user when unsure.
4. The `design.json` contract: full JSON example + ownership table (§6.2/6.3), "keep unknown
   keys", "set `updated`".
5. `rules/DESIGN-RULES.md` verbatim.
6. `rules/QUESTIONS.md` verbatim.
7. Rendering constraints (from §4.1): offline only, static relative references, no runtime
   fetch, links between screens as `<a href="other.html">` or `data-dc-goto`.

### 11.3 Chip core text (template in `src/shared/agent/chip.ts`)
```
[Design Chamber] New {canvas|artifact}: "{title}"
Brief: {brief | "(none — ask the user what to design)"}
Write ONLY inside: {abs folder}
Before anything else read, in full: {abs folder}/.chamber/RULES.md — it is part of this message.
Precedence: 1 the user's words here · 2 this project's design rules: {≤6 paths | none found} · 3 preset: {name | none} · 4 the design's DESIGN.md + tokens.css once confirmed · 5 built-in rules.
Viewports: {suggestion}. Ask if unsure (defaults Laptop 1280×800, Phone 390×844).
Files: {canvas: design.json, screens/<id>.html, tokens.css, DESIGN.md, assets/** | artifact: design.json, index.html, tokens.css, DESIGN.md, assets/**}. Never touch .versions/, .chamber/, .thumb.png.
design.json: you own title, updated, viewports, screens, designSystem; keep every other key as is.
Unsure? Ask brief questions with a recommended default first (RULES.md, "Ask when unsure").
```

### 11.4 Revision prompt (`revision-prompt.ts`)
```
[Design Chamber] Revise "{title}" — {N} comment(s). Folder: {abs}. Rules: {abs}/.chamber/RULES.md
Change only what the comments ask; keep everything else. Update design.json "updated". Reply per comment number.
{i}. {Screen "Home" (screens/home.html) @ Laptop 1280×800 | Artifact index.html @ Laptop 1280×800}
   element: `{selector}` {"(moved — matched by text)"|"(not found in current file)"}
   text: "{anchor.text}"  html: {anchor.html}
   → {body}
```
Over 16 000 chars → drop `html`, then truncate `text`, then send the first K comments and tell the
user "K of N sent; send again for the rest" (unsent stay `open`).

---

## 12. Repository layout and lanes

```
package.json tsconfig.json .gitignore        main agent (shared root files)
scripts/build.mjs scripts/pack.mjs           WP0 (then main agent)
src/shared/types.ts api.ts limits.ts
           bridge-protocol.ts design-json.ts WP0 (types/limits/protocol; design-json parser WP0)
src/shared/agent/**                          WP3 (chip, rules-doc, revision-prompt, html-extract)
src/service/main.ts http.ts context.ts       WP0
src/service/compose.ts                       integration (composition root)
src/service/paths.ts settings.ts root.ts store.ts watch.ts changes.ts uploads.ts outbox.ts
src/service/routes/{settings,designs,comments,changes,uploads,outbox}.ts   WP1
src/service/bundle.ts render-cache.ts versions.ts zip.ts export.ts reveal.ts chrome.ts thumbnails.ts
src/service/routes/{render,versions,export,thumbnails}.ts                 WP2
src/service/discovery.ts src/service/routes/{chat,presets}.ts             WP3
src/guest/**  (host, service-client, changes, store, camera, frame-doc, bridge/**, anchoring,
               flows, background-main.ts)                                  WP4
src/ui/**     (index.html, main.ts, styles.css, rail/**, page/**, wall/**, components/**)  WP5
test/shared/** test/service/** test/guest/** test/e2e/**   each WP its own subfolder (see WP)
test/helpers/** (fake-context, tmp-root, chrome-or-skip)   WP0
rules/**      rules author (read-only for WPs)
spikes/**     architect
dist/         build output, gitignored
```
Build (`scripts/build.mjs`, esbuild ^0.24, as design-canvas `scripts/build.mjs`): (1) bundle
`src/guest/bridge/bridge.ts` → IIFE string (`write:false`, minified; the build fails if it is < 1 kB,
i.e. the WP0 placeholder, or if `__DC_BRIDGE__` is left unreplaced); (2) `src/ui/main.ts` →
`dist/panel/main.js` IIFE es2020, `define: { __DC_BRIDGE__: JSON.stringify(bridge) }`; (3)
`src/guest/background-main.ts` → `dist/background/main.js`; (4) `src/service/main.ts` →
`dist/service/main.js` ESM node20 with the `createRequire` banner; (5) copy `src/ui/index.html`,
`src/ui/styles.css` → `dist/panel/`, write `dist/background/index.html`. tsconfig: strict,
`noUncheckedIndexedAccess`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `noEmit`,
`moduleResolution: Bundler`, lib ES2022+DOM, `types:["node"]`; imports use explicit `.ts`.
`declare const __DC_BRIDGE__: string` in `src/guest/globals.d.ts`.

---

## 13. UI (WP5) — screen by screen
All chrome uses `--oc-*` variables and kit components (`mountButton`, `mountSearchField`,
`mountTabs`, `mountSelect`, `mountMenu`, `mountList`, `mountEmpty`, `mountBanner`, `mountSpinner`,
`mountTextField`, `mountSwitch`, `mountBadge`). Glossary per `AGENTS.md`. Every async action has a
loading state and a user-facing error (service `message`). Keyboard: Tab order, Escape closes
popovers/drawers, wall shortcuts below. Light + dark verified.

### 13.1 Rail panel (320–480 px)
- **R1 List**: header row (title "Designs", New ▾ [Canvas…, Artifact…], ⚙). Search field; tabs
  All / Canvases / Artifacts. Rows: 64×40 thumbnail (data URL / live mini-frame / kind icon while
  pending), title, kind · relative updated, badges: "Waiting for agent" (pending), comment count,
  chat-linked dot. Click → R2. Row menu: Open, Continue in chat, Reveal in folder, Rename, Delete…
  (confirm, "moves to .trash"). Empty: "No designs yet — type /design in any chat" + New.
  Root notice banner when previous roots hold designs.
- **R2 Viewer** (compact): back, title, overflow menu (Continue in chat, Export ZIP, Export HTML,
  Copy HTML/Copy path, Reveal, Versions, Comments). Artifact: frame scaled to fit width at the
  chosen viewport (select), interactive. Canvas: the wall component in fit-all, Edit/Play toggle,
  zoom −/+/fit; max 4 live frames. Comments and Versions open as full-height sheets inside the rail.
  Footer hint (F11): "Full screen: sidebar → Extension pages → Design Chamber".
- **R3 Settings**: Designs folder (text field, Apply, Use default, validation message), previous
  folders (Switch back), Browser for thumbnails (detected path or "Not found — thumbnails use live
  previews", override field, Test), Permissions tip: "OpenCode asks before your agent writes outside
  the project. To allow Designs once: add to opencode.json" + snippet + Copy
  (`{"permission":{"external_directory":{"<root>/**":"allow"}}}`), version.
- **New dialog** (sheet): kind tabs, brief (multiline), preset select, destination (New chat |
  Current chat), Start. Errors inline.

### 13.2 Page
- **P1 Library**: toolbar (title, search, tabs, sort Updated/Created/Title, New ▾, ⚙). Responsive
  card grid (min 220 px): 16:10 thumbnail, title, kind badge, updated, linked-chat and comment
  indicators, "Waiting for agent" overlay for pending. Card menu as R1. Settings opens P5 as a
  side sheet. Live: cards update from change events without losing scroll.
- **P2 Canvas wall**: toolbar: back to library · inline-editable title · Edit/Play segmented ·
  viewport chips (toggle visibility; persisted per design in `host.storage` key `view:<slug>`) ·
  zoom − % + · Fit · Comments (count) · Versions · Continue in chat · ⋯ (Export ZIP, Export screen
  as HTML, Reveal, Copy path). Body: infinite wall (background `--oc-muted-surface`), artboards on
  the auto-grid (rows screens, columns viewports), each with a label "Home · Laptop 1280×800" and
  per-artboard status (spinner, "screens/x.html not written yet", "3 blocked" badge with tooltip
  list, Play-mode ↺ reset when navigated). Interaction:
  - Pan: wheel/trackpad over background, Space+drag, middle-drag, `H` toggles pan tool; arrows
    nudge; infinite in both axes.
  - Zoom: Ctrl/⌘+wheel and pinch (ctrl wheel) around the cursor, `+`/`−`, `Shift+0` 100 %,
    `Shift+1` fit all, double-click a label → focus artboard. Range 5–400 %.
  - Edit: hover outlines the element under the cursor (overlay rect from `hit`); click opens the
    comment composer anchored at the element (textarea, Add ⌘/Ctrl+Enter, Cancel Esc). Pins:
    numbered circles at the anchor's `point`; follow artboard scroll and zoom; click → thread
    popover (edit, resolve, delete). Detached pins render dashed at last rect and list under
    "Detached" in the drawer.
  - Play: frames interactive; pins hidden (toggle "Show pins"); in-design links navigate inside the
    artboard; external links ask "Open <url> in your browser?".
  - Live refresh: on `files` events only affected artboards reload (screen file → its row;
    `tokens.css`/`assets/**`/`DESIGN.md` → all); camera and per-artboard scroll preserved.
- **P3 Comments drawer** (right, 360 px): grouped by screen; each item: pin number, screen ·
  viewport, element text, body, status; filter Open/Sent/Resolved; footer **Send N comments to
  chat** (disabled with reason when 0) → §10.4; result toast.
- **P4 Versions drawer**: newest first: "v12 · 4 min ago · after agent turn" (reason labels:
  Auto-saved, After agent turn, Before restore, Restored), current marker / "Unsaved changes" when
  `dirty`. Actions: **View** (wall renders that version; banner "Viewing v12 — Compare · Restore ·
  Back to current"), **Compare** (each artboard split: version left, current right, shared camera;
  changed-files list from `/diff`), **Restore** (confirm: "Current state is saved as a version
  first"). Snapshot now (manual).
- **P5 Settings**: same as R3 in a sheet.
- **P6 Artifact viewer**: toolbar: back · title · viewport select (each design viewport + Fill) ·
  zoom fit/100 % · Comment mode toggle (same pins as canvas, `screen:null`) · Versions ·
  **Export ▾** (Download ZIP, Download single-file HTML) · **Continue in chat** ·
  **Copy ▾** (Copy HTML — enabled ≤ 32 000 chars, `writeClipboard` limit — else Copy path).
  Body: the artifact centred on the wall background at the viewport size, interactive like a
  browser. External-reference banner when `external.length`. After export: toast with path + Copy,
  and an inline "Show in folder" action.

---

## 14. Work packages

Order: **WP0** first (one agent, ~half a day), then **WP1–WP5 in parallel**. Interfaces are the
WP0 files; a WP that needs a change to a WP0 file asks the main agent, who edits it once and
notifies all lanes. Each WP ships tests in its own `test/<area>/` folder and passes
`npm run check`.

**WP0 — Scaffold and contracts** (fullstack-developer). Lane: `package.json` (manifest §5),
`tsconfig.json`, `.gitignore`, `scripts/build.mjs`, `scripts/pack.mjs`, `src/shared/{types,api,
limits,bridge-protocol,design-json}.ts`, `src/service/{main,http,context}.ts` (+ empty
`register*Routes` stubs in each `routes/*.ts` file listed in §12 so lanes only fill bodies),
`src/guest/globals.d.ts`, `src/ui/index.html` + `src/ui/main.ts` stub, `src/guest/background-main.ts`
stub, `test/helpers/**` (tmp root factory, fake `ServiceContext`, `chromeOrSkip`).
Acceptance: `npm run check` green; build emits the three entries; `/health` answers with bearer and
401 without; `design-json.ts` parse/normalise tests (valid, unknown keys kept, invalid fields
dropped with warnings); folder install in OpenChamber succeeds and shows an empty rail.

**WP0 deviations** (minimal fixes made while scaffolding; the WP0 files are the contract):
1. `GET /settings` `previousRoots` is `{ path, exists, designCount }[]`, not `string[]`. Without the
   count the UI cannot show "N designs remain in <old root>" (§9.2).
2. `warnings` everywhere is `DesignWarning { code, field?, message }`, not a bare string. `code` is
   the stable value (`no-design-json`, `invalid-viewport`, …) and `message` is the sentence to show.
3. `VersionReason` adds `manual`, because `POST /designs/:slug/versions` takes `reason:"manual"`
   (P4 label: "Saved manually"). Routes answer `VersionSummary` = `VersionEntry` without `files`,
   plus `fileCount`.
4. Viewport ids are not fixed by §6.2. WP0 uses `^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$` (`limits.ts`).
   Limits that §6 implies but does not number: anchor selector ≤ 1 000, ≤ 500 comments, session id
   ≤ 128, project directory ≤ 4 096, plus id patterns for comment, version, upload and preset.
5. Bridge (§8.3): the envelope also carries `nonce` (from `window.__DC.nonce`), so messages from a
   replaced document are ignored. `hit` echoes `x,y` and carries `element: HitElement | null`
   (null when nothing is under the point). `key` also accepts `=` (unshifted +). The artboard id is
   `artboardIdOf(screen|null, viewport)` = `<screen|artifact>@<viewport>`.
6. API additions: error code `unauthorized` (401 body); `PUT /uploads/:id/:index` answers
   `{ received, complete }`; `POST /designs/:slug/prompt` answers `omitted` (ids left out by the
   16 000 cap, so the UI can say "K of N sent"); `DELETE /outbox` answers the taken slot
   (exactly-once). The first `GET /changes` sends `since=0&epoch=` and gets `reset:true`. A wrong
   method on a known path is 404, not 405.
7. `ServiceContext` (§9.7) also has `version`, `epoch` (/health and the hub share it), `uploads`,
   `outbox`, `thumbnails.peek` (thumb state for list summaries, WP2 → WP1) and `onDispose`.
   `DesignRecord` carries `state` and `extra`. ~~Until integration, `main.ts` wires
   `unavailable(name)` placeholders that answer 500 "not built yet".~~ **Obsolete** — `compose.ts`
   wires the real modules (Integration deviation 1).
8. design.json writes never re-serialise the normalised view. `mergeServiceFields` patches the
   service keys into the agent's raw object, so unknown and even invalid agent values survive. A
   canvas mirror has no `entry` key. A design.json that fails to parse (`raw:null`) is never
   written over.
9. Placeholders outside the WP0 list, needed for the build to have entries:
   `src/guest/bridge/bridge.ts` (WP4 replaces it) and `src/ui/styles.css` (WP5). Root `LICENSE`
   and `README.md` exist because `npm run pack` ships them (§5). `.agents/package.json`
   (`"type":"commonjs"`) keeps the CommonJS `verify-team.js` running under the root `"type":"module"`.
10. `test/helpers/` also has `service-process.ts`, which starts `src/service/main.ts` as the host
    does, for §15.2. `esbuild ^0.24` carries a moderate `npm audit` advisory for its dev server,
    which this repo never runs.

**WP1 — Service core: store, settings, watch, comments, chat plumbing** (fullstack-developer).
Lane: §12 WP1 files + `test/service/core/**`. Implements routes `settings, changes, designs
(list/get/create/patch/delete), comments, uploads, outbox`, §6.3 merge, §9.1–9.4.
Acceptance/tests: containment (win32 cases: `..`, `C:\`, `\\server`, mixed case, symlink/junction
out), slug rules; root change never moves files and records previousRoots; agent overwrite of
design.json losing comments is re-merged within 1 s and no write loop; `/changes` long-poll returns
on change and on timeout, `reset` on epoch change; upload chunking reassembles 200 000 chars;
`.trash` delete; corrupt settings tolerated.

**WP2 — Service rendering, versions, export, thumbnails** (fullstack-developer, second agent).
Lane: §12 WP2 files + `test/service/render/**`. Codes against `ServiceContext` (fake in tests).
Acceptance/tests: bundler fixtures (css `@import` chain + `url()` fonts, `srcset`, inline style
url, `../assets` from screens, missing → `missing`, escape → `blocked`, https → `external`,
`</script>` escaping); output renders in headless Chrome with no network (e2e, skip without
Chrome); chunked render reassembles > 6 MB doc byte-exact; versions: auto after quiet, turn flush,
dedupe, restore + restore-point, prune/GC; ZIP opens with system unzip / round-trips through a
reader test; single-file HTML has no relative refs; thumbnail PNG 320×N produced (skip without
Chrome) and `unavailable` with no browser; reveal refuses non-issued paths.

**WP3 — Agent instructions** (fullstack-developer or architect-reviewed; pure code). Lane:
`src/shared/agent/**`, `src/service/discovery.ts`, `src/service/routes/{chat,presets}.ts`,
`test/agent/**`. Implements §11 and `/chip`, `/designs/:slug/prompt`, `/artifacts/from-message`,
`/presets`, plus `onCreate` hook writing RULES.md.
Acceptance/tests: chip text ≤ 15 000 for max inputs (brief 2 000, 20 project sources); RULES.md
contains every layer in order and both rules files verbatim; discovery fixtures (DESIGN.md, tailwind
screens, CSS @media frequencies, AGENTS.md with/without design heading, skip node_modules, time
cap); revision prompt truncation ladder; `extractHtml` (```html, ```htm, unlabeled doctype block,
longest wins, none → null); presets parsed from `rules/presets/*.md` (id, name, best for).

**WP4 — Guest core** (fullstack-developer). Lane: `src/guest/**`, `test/guest/**`,
`test/e2e/bridge*.test.ts`. Implements §8.2, §8.3, §10, the background entry, and a
`createFakeServices()` for WP5 (delivered first, day 1, from WP0 types).
Acceptance/tests: camera math (zoom around point keeps the point fixed, fit-all, clamps, layout
grid); selector generation + anchor resolution on fixtures (unit over a fake `El`, plus e2e in
headless Chrome running the real bridge in a blob frame inside a CSP'd sandboxed page — reuse
`spikes/nested-frame/run.mjs` harness); message validation rejects foreign `source`/bad shapes;
chunked render loader; upload chunker respects F7 limits for multi-byte text; flows with a fake
`HostClient`: send-comments three branches incl. busy and outbox exactly-once, continue-in-chat
fallback on `NO_SESSION`, reconciliation picks newest session, open-as-artifact no-html toast.

**WP5 — UI** (ui-ux-developer; loads `frontend-design` skill). Lane: `src/ui/**`,
`test/ui/**` (pure view-model tests only). Builds §13 against WP4's store/flows (fake services
until WP4 lands). Acceptance: all §13 screens in rail (320 and 480 px) and page, light + dark,
using only `--oc-*` tokens and kit components; keyboard paths; every service error surfaces as a
sentence; screenshots of each screen in `documentation/pages/` per protocol; smoke §15.3 passes.

Integration (main agent): after WP1–WP5 merge, one integration pass wires `main.ts` real modules,
runs §15.3, and files fixes back to the owning lane.

### Integration deviations (WP1–WP5 merge and service integration)
Earlier sections were corrected inline where they differed; this list is the audit trail.
1. **Composition root.** `src/service/compose.ts` (`composeService`) builds and wires every module
   and registers all routes; `main.ts` only serves it. No `unavailable()` placeholders remain
   (WP0 deviation 7 is obsolete). `GET /settings` `chrome` uses `chrome.ts` `resolveBrowser`, so
   `source:"detected"` works. The `service-process` test helper isolates settings and root in tmp.
2. **`anchorStates`.** `PromptBody` has optional `anchorStates` (`AnchorState` in `shared/types.ts`);
   `/designs/:slug/prompt` validates it and `buildRevisionPrompt` prints "(moved — matched by text)" /
   "(not found in current file)". Guest: `anchoring.anchorStatesOf(placements)`,
   `flows.sendComments(slug, ids?, anchorStates?)`.
3. **Bridge placeholder.** `BRIDGE_PLACEHOLDER` lives in `src/shared/bridge-protocol.ts`;
   `frame-doc.ts` `injectBridge` swaps it for the bridge. `scripts/build.mjs` asserts the bridge
   bundle is ≥ 1 kB and has no unreplaced `__DC_BRIDGE__`.
4. **Single containment.** `src/service/paths.ts` exports `resolveInside` and the disk-free
   `isStrictlyInside`; `bundle.ts` (`classifyRef`, live file source) uses them and its own
   `isInsideDir` is gone. Hardening: `.versions/index.json` entries must have safe, tracked paths
   and sha256 object names, and restore writes/deletes through `resolveInside`, so a tampered index
   cannot write outside the design folder.
5. **Windows reserved names.** `slugify` maps device names to `<name>-design`; `uniqueSlug`
   refuses a reserved base.
6. **WP4 extras.** `frame-channel.ts`, `bridge/links.ts`, `fake-services.ts` (§8.2). Render docs are
   cached in `service-client` (LRU by render key); the store keeps only `renderRevs`.
   `docs/GUEST-API.md` is the guest contract for the UI.
7. **WP2 notes.** Render cache LRU 256 MB; chunks ≤ 6 MB, never splitting a surrogate pair; versions
   prune to 100 with object GC.
8. **WP3 judgment calls.** Agent-file design headings use a word-bounded filter (`ui` does not match
   "build"); breakpoint suggestions add Phone for any `min-width` breakpoint and Laptop for any
   `max-width` one, on top of the ≤ 480 / ≤ 1024 rule; `/chip` validates `sessionId` but does not
   store it (§10.1: reconciliation links later).
9. **UI.** P6's button is labelled "Continue in chat" (§13.2). WP5 was built against a temporary
   `src/ui/dev/guest-shim.ts`; integration swaps it for the real `src/guest` modules.
10. **Open as artifact.** The guest answers "No HTML code block" via `extractHtml` before uploading;
    the service's 422 `no-html` stays the authority.

### Review and smoke fix round (2026-10-27)
Sources: `documentation/reviews/2026-10-27-code-review.md` (Resolution) and
`documentation/smoke/REPORT.md` (Fix round). Sections above were corrected inline.
- **Restore (C1, C2, §9.5).** `snapshotNow` takes `keep` (prune skips the version being restored) and
  `required` (an over-cap tree throws 422 `invalid` before any write instead of skipping the restore point).
- **design.json two writers (M1, §6.3/§9.3).** `replaceFileIfUnchanged` in `paths.ts`; the store re-merges up
  to 5 times (`store.design-json-busy` after that). Create lock key `'\0create'`.
- **Non-design folders and root safety (M2, §6.1/§9.2/§9.3).** `isDesignFolder` gates list, `dir`, counts;
  `PUT /settings` refuses home, its ancestors and `Documents` itself; folder errors are sentences
  (`folderErrorSentence`, KI-5). `projectDirectory` on `POST/PATCH /designs` must be absolute and NUL-free
  (400 `bad-path`); `GET /source` reads through `resolveInside`.
- **Watcher (KI-1, §9.4).** The poll fingerprint records top-level non-dot entry names, not the design
  folder's mtime, so the service's own dot-writes are silent.
- **Open as artifact (M1 smoke, §5/§7/§10.7).** Manifest `mode:"background"`; `POST /artifacts/from-message`
  takes `open?` and answers `{ slug, title }`; new `DELETE /open-request` (`OpenRequest`,
  `OpenRequestResponse`, `OPEN_REQUEST_TTL_MS`); `flows.runAction` + `flows.watchOpenRequests`.
- **Thumbnails (KI-3, §4.4/§9.5).** Forced light scheme, stored as `scheme` in `thumb.json`.
- **Turn snapshots (m5, §9.5/§10.6).** `TURN_PROMOTE_AUTO_MS`; lifecycle `completed` counts only after a
  seen `started`; unselected linked chats snapshot from the project sessions list (`finishedTurns`).
- **Send comments (KI-2, §10.4).** mark-sent retried once and non-fatal (`markFailed`).
- **UI-side (no spec contract change).** Fit aims at the wall minus a drawer laid over it below 720 px
  (`fitArea`, `FIT_MIN_WIDTH`, KI-4); long folder paths are middle-truncated (`middlePath`).
- Moved `test/review/thumbnail-network` into `test/service/render/`; `fake-services.ts` stays in `src/guest/` (m4, open).

---

## 15. Test plan

### 15.1 Unit (`node --test`, Node ≥ 22.18, TS stripped natively)
Pure modules: `design-json`, paths/containment (run on win32 and posix path flavours via
`path.win32`/`path.posix` injection), slug, camera, selector/anchor, bridge-protocol validators,
chip/RULES/revision builders, html-extract, discovery (fixture trees in `test/fixtures/`), zip
writer, bundler tokenizer, version tree hashing.

### 15.2 Service integration
`test/service/**` start the real service on an ephemeral port with `OPENCHAMBER_SERVICE_TOKEN`,
`DC_SETTINGS_PATH` and a tmp root; drive it with `fetch` exactly like the host proxy (JSON body
string, bearer). Cover every route in §7 incl. 401, 413, containment refusals, long-poll, and a
scripted "agent" that writes files (atomic and non-atomic) while the watcher runs. Chrome-dependent
tests use `chromeOrSkip()` (skip is reported, never silent).

### 15.3 Smoke click-through in a live OpenChamber (agents may do this, BRIEF Process)
`npm run build` → OpenChamber **Settings → Extensions → Add from folder** → repo path → approve
(prompt, sessions, local service) → checklist (screenshots into `documentation/`):
1. Rail icon shows; list empty state; theme switch light↔dark repaints rail and page live.
2. `/design a pricing page for a coffee subscription` in a project chat → chip appears; send →
   design appears "Waiting for agent" → agent writes files → artboards appear live without reload;
   thumbnail appears.
3. Page (sidebar → Extension pages → Design Chamber): library → canvas wall: pan both axes, zoom
   to cursor, fit all, Edit hover outline, add 2 pins, Play mode link navigation between screens.
4. Send comments → linked chat receives one revision message (also from a different selected
   chat → outbox path); after the agent turn a version appears; View/Compare/Restore.
5. `/artifact`, then Export ZIP and single-file HTML → files in Downloads, toast path, Show in
   folder; open the HTML file in a browser offline: identical.
6. Assistant message with an ```html block → ⋯ → Open as artifact → rail viewer shows it.
7. Settings: change root to a tmp folder → list empties, old designs untouched, Switch back works.
8. Rename Chrome path to nonsense → thumbnails fall back to live mini-frames.
Uninstall afterwards only if this run installed it.

---

## 16. Risks

| Risk | Mitigation |
|---|---|
| Page can't be opened from code (F11) | Rail viewer is a full viewer; hint text; owner Q1 |
| OpenCode prompts for `external_directory` on every write to Designs | Settings tip + copyable snippet; owner Q3 |
| LLM artifacts that load Tailwind/fonts from CDNs render unstyled (F2) | `external` banner + "make it self-contained" action; rules forbid CDNs |
| Memory with many artboards × inlined images | 12-frame budget, LRU caches; v2 postMessage-blob bootstrap (F4) |
| `fs.watch` misses events on OneDrive/network roots | 3 s poll backstop |
| Agent and service both write design.json | §6.3 state.json authority + idempotent re-merge |
| `onSessionLifecycle` only for the frame's session | quiet-period auto snapshots cover the rest |
| Command name `/design` collides with another extension/skill (host drops ours, `DOCUMENTATION.md:53`) | smoke step 2 detects; fallback names `dc-design`/`dc-artifact` |
| Chrome absent / slow Edge cold start | `unavailable` → live mini-frames; 20 s kill |
| Long-poll per frame keeps requests open | ≤ 2 visible frames, 15 s wait, stop when hidden |

## 17. Owner questions — resolved 2026-10-26 (`docs/BRIEF.md`, "Owner decisions on spec questions")

- **Q1** Full-screen page can't be opened by the extension (F11), so "Open as artifact" and chip
  clicks open the rail viewer. Resolved: accept (rail viewer + hint to sidebar → Extension pages).
- **Q2** Allow Google Fonts in designs via `contributes.origins` (`fonts.googleapis.com`,
  `fonts.gstatic.com`; adds an install approval)? Resolved: **no** — fonts are bundled in `assets/`.
- **Q3** When the agent writes to `~/Documents/Designs`, OpenCode asks for permission outside the
  project. Resolved: Settings shows a copyable opencode.json snippet; never edit the user's config.
- **Q4** Exports go to `~/Downloads`. Resolved: yes, with a "Show in folder" toast; no folder setting in v1.
- **Q5** Delete = move to `<root>/.trash/`. Resolved: yes, no auto-empty.
- **Q6** Comments on artifacts too (same pin engine)? Resolved: yes.

Cross-lane note for the rules author (not edited here): `rules/DESIGN-RULES.md` §5 says
"Responsive = one artboard per real viewport of the same screen (`home-phone`, `home`)". The wall
renders every screen at every viewport in `design.json.viewports` (optional per-screen
`viewports` subset), so a responsive screen should be **one file** with responsive CSS, not one
file per viewport; please align that line.
