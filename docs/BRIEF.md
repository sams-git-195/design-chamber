# Design Chamber — product brief (source of truth for decisions)

Design Chamber is an OpenChamber extension: a Claude Design–style design canvas plus
Claude-artifacts–style HTML canvases, rendered **inside OpenChamber**, with designs written
as plain files by the user's own chat agent.

Owner decisions (2026-10-26). Anything not listed here is open — ask, don't guess.

## Platform
- OpenChamber extension (SDK `apiVersion: 1`), source of OpenChamber at
  `~/Documents/GitHub/openchamber` (SDK: `packages/sdk/DOCUMENTATION.md`, `API.md`,
  `GUEST_SERVICES.md`, `examples/`). Target OpenChamber >= 2.5.0.
- New repo. Reuse proven pieces from `~/Documents/GitHub/openchamber-design-canvas`
  (v0.3.0, MIT, same owner) where they help: Chrome discovery, wall pan/zoom math,
  design-system precedence, prompt rules, presets, gates. Do not inherit its
  external-Chrome-window + Vite-dev-server architecture.
- Rendering is **in-app**: rail `panel` = navigator, full-screen `page` = viewer/canvas.
  Designs render in sandboxed blob/srcdoc iframes fed by the extension's local `service`.
  Colours follow OpenChamber's active theme (host theme tokens / SDK UI kit).
- Must not declare `provides: ["browser"]` (would fight Design Canvas).

## Storage
- Default root `~/Documents/Designs`; user can change it (persisted setting); existing
  designs are not silently moved.
- One folder per item: `Designs/<slug>/` with `design.json`
  (`kind: "artifact" | "canvas"`, title, created/updated, linked `sessionId`, viewports,
  screen list, comments), `index.html` (artifact) or `screens/*.html` (canvas), `assets/`,
  `DESIGN.md` + `tokens.css` (per-design design system), `.versions/` (snapshots).

## Creation / editing
- The chat agent writes the files. `/design <brief>` (and an "artifact" variant) in any chat
  attaches: the design rules, the target folder, the design.json contract.
- Extension watches the folder and refreshes live.
- Each design remembers its chat session: "Continue in chat" reopens it; comments and
  revisions go to that session (new chat if none / gone).
- Message action "Open as artifact": an assistant message with an HTML code block becomes an
  artifact in Designs and opens in the viewer.

## Views
- **List**: thumbnail grid of designs (rail + page), headless-Chrome PNG thumbnails cached on
  change; fallback to live mini-iframe when Chrome is missing.
- **Rail panel** for navigating artifacts and designs.
- **HTML canvas (artifact)**: renders a standard HTML page with its local images, like a
  browser. Export: **ZIP** (html + assets, like Claude Desktop artifact download) and
  **single-file HTML** (assets inlined).
- **Design canvas**: an infinite wall with horizontal + vertical scroll/pan and zoom showing
  multiple screens × multiple viewports as artboards.
  - Edit / Play mode (Play = clickable prototype inside its artboard).
  - Pinned comments anchored to an element; the element's selector/snippet travels with the
    comment; "send comments" posts one revision request to the linked chat.
  - Version snapshots per agent turn; compare / restore.

## Design rules (agent instructions)
Precedence, highest first:
1. The user's words in chat.
2. The **active project's** design rules if any exist (DESIGN.md, design tokens/theme files,
   AGENTS.md / CLAUDE.md design sections, existing breakpoints/viewports) — always looked for
   first.
3. Chosen bundled style preset (if any).
4. Per-design `DESIGN.md` + `tokens.css` once confirmed.
5. Built-in anti-slop rules + design best practices.
- Instruction to **ask the user questions when unsure** (brief, with recommended defaults).
- Viewports: derive from the project first; ask which viewports to show when unsure.
  Defaults: Laptop 1280×800 and Phone 390×844.
- Bundled style presets pickable at creation.

## Owner decisions on spec questions (2026-10-26)
- Chips / "Open as artifact" open the compact viewer in the rail (extensions can't open their
  full-screen page from code); hint points to sidebar → Extension pages.
- No Google Fonts / CDNs in designs; fonts bundled in `assets/`, system fallbacks.
- Agent write permission: Settings shows a copyable `opencode.json` snippet; never edit the
  user's config.
- Exports (ZIP, single-file HTML) go to `~/Downloads` with a "Show in folder" toast.
- Delete moves a design to `<root>/.trash`.
- Comment pins work on artifacts as well as canvases.

## Process
- Public GitHub repo, MIT, default branch `master` with branch protection (PR + 1 approval + CI; owner-only bypass). (Updated 2026-10-27; was local-only.)
- Agents may folder-install into the user's running OpenChamber for smoke tests.
