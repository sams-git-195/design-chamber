# Design Chamber — Agent Guide

## Product context
- An OpenChamber desktop-app extension that renders Claude-Design-style design canvases and Claude-artifacts-style HTML canvases inside OpenChamber, from plain files the user's own chat agent writes to `~/Documents/Designs`. Not the external-Chrome-window design tool `openchamber-design-canvas` — rendering is in-app.
- Personas: **The OpenChamber user** (designer-developer who chats with an agent to produce designs and wants to see, comment on, version and export them without leaving OpenChamber). The user's chat agent is the author of every design file.
- Sources of truth: `docs/BRIEF.md` (owner decisions — anything not listed there is open: ask, don't guess; edit only on the user's instruction) and `docs/SPEC.md` (technical spec: the authority for architecture and lanes; changes go through the architect).

## How we work
**Full process: `.agents/rules/claude-agent-protocol.md` — read it before your first task.**
(Claude Code loads it through `CLAUDE.md`; every other harness reads it explicitly.) The
short version, which holds even if you read nothing else:

- **The main agent leads.** There is no project-manager agent: the session talking to the
  user plans, dispatches the specialists below, tracks their evidence, and reports back.
  Prefer dispatching. For a small, quick, single-discipline change with no risk surface, the
  main agent may do it directly — after reading that specialist's file and following its
  rules, workflow and self-check.
- **Open permissions, user-gated actions.** Agents may edit any file and run any command the
  task needs, and commit freely. They `git push`, open or merge PRs, create GitHub repos,
  publish or release the extension (`npm publish`, tags, releases), uninstall or delete
  OpenChamber extensions they did not install, delete anything under `~/Documents/Designs`
  they did not create, `rm -rf` outside the repo, or edit the OpenChamber source
  (`~/Documents/GitHub/openchamber`, `~/Documents/GitHub/openchamber-design-canvas` — read-only
  references) **only when the user has said so in this conversation** — and when the user has
  said so, they do it without asking again. Not asked yet → finish, commit, and offer the exact
  command. Folder-installing this extension into the user's running OpenChamber for smoke
  tests is allowed. Local secret files (`.env` if one is ever created (none expected)) may be read and updated; their values
  never reach a commit, a log, or a report.
- **Stay in your lane.** Each agent focuses on what it owns (table below). A small adjacent
  edit the task needs is fine and gets named in the report; anything larger goes to its owner.
- **Senior ladder before any code:** (1) does this need to exist? (2) is it already in this
  codebase — reuse it; (3) does an installed dependency do it; (4) can it be one line;
  (5) only then the minimum that works — **without** dropping error handling, graceful
  user-facing errors, or any part of the user experience.
- **Evidence, not claims.** Gates are run and their output quoted. Unknown business rules are
  asked, never guessed.
- **Reports to the user:** Direct depth (concise), protocol §7 shape (outcome first, structured,
  no preamble).

## Agent team
| Agent | Focus (owns) | Hands off to |
|---|---|---|
| **Main agent** (the session itself — no file) | Plans, dispatch, tracking, small direct changes; `AGENTS.md`, agent files, `.agents/**`; **shared root files** — root `package.json`, lockfile, `tsconfig.json`, `.gitignore`, the esbuild config (`scripts/build.mjs`) and `scripts/pack.mjs`, the extension manifest, `opencode.json`, `.claude/settings.json` — which it edits itself or assigns to one builder at a time | all agents |
| product-specialist | Requirement specs for features and flows (returned as a report; persisted to `documentation/specs/<feature>.md` on request); no code, no technical decisions | architect |
| architect | Technical designs and threat models; `documentation/specs/**`; keeps `docs/SPEC.md` current on the main agent's request; no production code | fullstack-developer, ui-ux-developer |
| fullstack-developer | All non-presentation code: `src/shared/**` (`types.ts`, `api.ts`, `limits.ts`, `bridge-protocol.ts`, `design-json.ts`, `agent/**`), `src/service/**` (`main.ts`, `http.ts`, `context.ts`, `routes/*.ts` and the lane modules), `src/guest/**` (host, service-client, changes, store, camera, frame-doc, `bridge/**`, anchoring, flows, `background-main.ts`, `globals.d.ts`), `test/**` except `test/ui/**` — layout per `docs/SPEC.md` §12 | qa-tester |
| ui-ux-developer | Presentation: `src/ui/**` (`index.html`, `main.ts`, `styles.css`, `rail/**`, `page/**`, `wall/**`, `components/**` — panel and page markup, styles, viewer chrome around the iframes) and `test/ui/**` (pure view-model tests) — layout per `docs/SPEC.md` §12; carries the Design and Usability bars | qa-tester |
| qa-tester | Verification after every implementation; regression tests (`test/**`); 🟣 entries in `documentation/known-issues.md`; never fixes production code | main agent |
| code-reviewer | Independent review of a diff, on the user's request; logs minor issues to `documentation/known-issues.md` | main agent |

`rules/**` (design-rules content: bundled presets and agent instructions) is written by a separate
rules author, not by this roster — read it, don't edit it unless the task is about it. Files two
builders both touch (the panel/page entry `src/ui/main.ts`, shared types the UI imports) are
sequenced by the main agent. The WP0 interface files — `src/shared/{types,api,limits,bridge-protocol,design-json}.ts`
and `src/service/{main,http,context}.ts` — change only through the main agent, who notifies every
lane (`docs/SPEC.md` §14). The layout is `docs/SPEC.md` §12; if they disagree, the spec wins.

Claude Code: agents live in `.claude/agents/*.md`, permissions in `.claude/settings.json`.
OpenCode: the same team in `.opencode/agents/*.md`, permissions in `opencode.json`; the main
agent is OpenCode's default `build` agent. When a convention changes, update both sets
together — same roster, same rules, same policy.

## Dev commands
- `npm run build` — `scripts/build.mjs` (esbuild): `dist/panel/` (panel + page guest, IIFE), `dist/background/` (slash-command guest, IIFE), `dist/service/main.js` (Node ESM). `dist/` is gitignored — build before a folder install.
- `npm run typecheck` — `tsc --noEmit`, strict.
- `npm test` — `node --test --test-concurrency=1 "test/**/*.test.ts"` (Node ≥ 22.18 strips the types; one file: `node --test test/shared/design-json.test.ts`).
- `npm run check` — typecheck + build + test.
- `npm run pack` — release zip `design-chamber-<version>.zip` (run `npm run build` first; publishing it is user-gated).
- **Quality gates: `npm run typecheck`, `npm run build` and `npm test` all pass before any task is done; `npm run check` runs them together.** No dev/watch command: there is no dev server by design (`docs/SPEC.md` §1); rebuild with `npm run build`.

## Critical gotchas
- **OpenChamber SDK `apiVersion: 1`, target OpenChamber >= 2.5.0.** Reference docs live in `~/Documents/GitHub/openchamber/packages/sdk/` (`DOCUMENTATION.md`, `API.md`, `GUEST_SERVICES.md`, `examples/`) — read-only; verify an API there before using it.
- **Never declare `provides: ["browser"]`.** It would fight Design Canvas.
- **`openchamber-design-canvas` (v0.3.0, MIT, same owner) is a parts bin, not a base.** Reuse Chrome discovery, wall pan/zoom math, design-system precedence, prompt rules, presets and gates; do not inherit its external-Chrome-window + Vite-dev-server architecture. Read-only.
- **Agent-written HTML is untrusted.** It renders only in a sandboxed srcdoc/blob iframe; never combine `allow-scripts` with `allow-same-origin`; guests never see the bearer token or host bridge.
- **The designs root is user data.** Default `~/Documents/Designs`, changeable (persisted setting); existing designs are never silently moved; every path is resolved and contained under the root before use.
- **Windows host.** Backslashes, drive letters and a case-insensitive filesystem make naive `startsWith` containment checks unsafe — use one tested containment function.
- **Guests are IIFE bundles** (esbuild) — no runtime ESM imports, no dev server.
- **Process:** GitHub repo `design-chamber` (public, MIT), default branch `master`, protected: no direct pushes — work on a branch, open a PR (template in `.github/`), CI (Ubuntu, Windows, Fedora) must pass and 1 approval is required; only the owner merges (bypass). Head branches auto-delete. macOS is not in CI — run `npm run check` on a Mac for macOS-affecting changes. Pushing a branch and opening a PR are still user-gated (§6).

## Architecture
Authority: `docs/SPEC.md`; this section is a summary.
- Rail `panel` = navigator; full-screen `page` = viewer/canvas; both sandboxed-iframe guests of the OpenChamber extension host, fed by the extension's local Node `service` (loopback, bearer-authenticated).
- Storage: one folder per item, `Designs/<slug>/` with `design.json` (`kind: "artifact" | "canvas"`, title, created/updated, linked `sessionId`, viewports, screens, comments), `index.html` (artifact) or `screens/*.html` (canvas), `assets/`, `DESIGN.md` + `tokens.css`, `.versions/`.
- The chat agent writes the files; the service watches the folder and the UI refreshes live. `/design <brief>` and an artifact variant attach the design rules, target folder and `design.json` contract to any chat.
- Thumbnails: headless-Chrome PNGs cached on change; fallback to a live mini-iframe when Chrome is missing.

## Business rules
Product decisions are in `docs/BRIEF.md`; anything not listed there is open.
| Topic | Rule |
|---|---|
| Design-rules precedence (highest first) | 1 the user's words in chat · 2 the active project's design rules (DESIGN.md, token/theme files, AGENTS.md / CLAUDE.md design sections, existing breakpoints) · 3 chosen bundled style preset · 4 per-design `DESIGN.md` + `tokens.css` once confirmed · 5 built-in anti-slop rules |
| Default viewports | Laptop 1280×800, Phone 390×844 — derive from the project first; ask when unsure |
| Artifact export | ZIP (html + assets) and single-file HTML (assets inlined) |
| Design canvas | infinite wall, pan/zoom, multiple screens × viewports as artboards; Edit/Play modes; element-anchored comment pins (selector/snippet travels with the comment); "send comments" = one revision request to the linked chat; version snapshot per agent turn, compare/restore |
| Linked chat | each design remembers its `sessionId`; "Continue in chat" reopens it; new chat if none/gone |

## UI
- **Design direction:** native fidelity. The extension must look like part of OpenChamber in the rail panel (~320–480 px) and the full-screen page — host theme tokens and the `@openchamber/sdk/ui` kit, no palette or typeface of our own. Colours follow the active OpenChamber theme live.
- Tokens: OpenChamber host theme tokens (`ready.theme.tokens`) and the `@openchamber/sdk/ui` kit look — never a raw hex or a one-off size (a design's own `tokens.css` is design content for the guest, not host chrome) · Colors: from the host theme · Type: from the host theme.
- Breakpoints: n/a in the web sense; verify the rail-panel width (~320–480 px) and the full-screen page, light and dark.
- Core flows (each has a step budget): browse the designs list → open an artifact and export ZIP/HTML · open a design canvas wall → pan/zoom · add a comment pin → send it to chat · restore a version · change the designs folder.
- Glossary (one term per concept): **design** = an item folder; **artifact** = a single HTML page design; **canvas** = a multi-screen design wall; **screen** = one page of a canvas; **viewport** = a device size; **artboard** = a screen at a viewport; **pin** = an element-anchored comment; **version** = a snapshot.
- Generic-looking UI is a defect here: the Design bar in the UI developers' agent files applies to every screen, whoever builds it. Load the `frontend-design` skill before UI work.

## Local service
Loopback-only, bearer-authenticated; every path contained under the designs root; the host passes the port and token in `OPENCHAMBER_SERVICE_PORT` / `OPENCHAMBER_SERVICE_TOKEN`; routes are `docs/SPEC.md` §7, typed in `src/shared/api.ts`. Deploy-type commands (publish, release, `gh repo create`, PRs, push) wait for the user's go-ahead.

## Documentation
Plain-English living docs in `documentation/` (see protocol §4): `README.md` index +
`pages/<page>.md` + `features/<feature>.md` + `known-issues.md`. Updated by whoever makes the
change, confirmed by the main agent before any feature is Done; qa-tester verifies. Written
for humans and future model sessions with zero context.
