# Agent instructions

**What it does:** When the user starts a design (`/design`, `/artifact`, or "New" in the extension), Design Chamber attaches instructions to the chat so the user's own agent designs the way this product expects: it reads the project's own design rules first, asks the user when it is unsure, writes only inside the design's folder, and keeps `design.json` correct.

## The two pieces
- **The chip** — a short message (typically 2 000–3 000 characters; never more than 15 000) attached to the chat. It tells the agent, in numbered steps: read `<design folder>/.chamber/RULES.md` first; look for the active project's design rules; the order of precedence; which viewports to use; to ask 3–6 questions with recommended defaults when unsure; which files to write; who owns which `design.json` keys.
- **`.chamber/RULES.md`** — the full instructions, written into the design's folder when the design is created and refreshed every time the extension sends a revision or "continue" message. In order: the design and its file map → what to do in what order → precedence layers 1–5 (the user's words · the project's design rules · the chosen style preset, inlined · this design's `DESIGN.md` + `tokens.css` · the built-in rules) → viewports → the `design.json` contract → `rules/DESIGN-RULES.md` word for word → `rules/QUESTIONS.md` word for word → rendering constraints (offline, relative paths, no CDNs).

## Looking for the project's design rules
The extension scans the chat's project folder (read-only, quick) and lists what it found so the agent can read those files itself: design documents (`DESIGN.md`, `docs/design*.md`, style guide, brand notes), token and theme files (`tokens.css`, `*tokens*.json`, `theme.*`, Tailwind config, CSS with a `:root` token block or `@theme`), and `AGENTS.md` / `CLAUDE.md` / Copilot / Cursor rule files that have a design-related heading. It skips `node_modules`, `.git`, `dist` and similar, goes at most four folders deep, and stops after 3 000 entries or 1.5 seconds. The list is a shortcut: the agent is also told to search for anything it missed.

Breakpoints found (Tailwind `screens`, the four most used `@media` widths) become a viewport suggestion: up to 480 px → Phone 390×844, up to 1024 px → Tablet 768×1024, above → Laptop 1280×800 (Desktop 1440×900 from 1440 px). A `min-width` breakpoint also implies a Phone (mobile-first); a `max-width` one implies a Laptop. With nothing found, the agent is told to ask which viewports to show and to recommend Laptop 1280×800 + Phone 390×844.

A chat that is not inside a project (or runs inside the Designs folder itself) has no project rules; the agent is told to ask whether a codebase or brand should be followed.

## Style presets
`rules/presets/*.md` are listed in the New dialog (name and "best for"). The chosen preset's file is inlined in `RULES.md` as layer 3.

## Revision requests ("send comments")
One message with every comment: screen and viewport, the pinned element (selector, text, opening tag), and the user's words. When the page could not find a pin's element exactly in the current file it says so next to the element — "(moved — matched by text)" or "(not found in current file)" — so the agent knows the selector is stale. If the message would be too long for the host (16 000 characters) it shrinks in order — element tags first, then element text, then it sends only the first comments and the rest stay open for another send.

## "Open as artifact"
The longest HTML code block in an assistant message becomes an artifact (a block labelled `html` / `htm`, or any block that looks like a full page). A message with no HTML block answers "No HTML code block in this message" and creates nothing (the extension checks before uploading the message; the service checks again). The title comes from the page's `<title>`, else the message's first heading, else the chat's title.
The action runs in the hidden background frame, so it works whether or not the rail is open: it saves the artifact, opens the Design Chamber rail on its viewer (the rail takes a one-time "open request" from the service on mount, or when the new design appears in an already open rail; it expires after 2 minutes) and confirms with a toast — *Saved as artifact "…"*. Where there is no side panel the toast says to open Design Chamber to see it.

## Rules and edge cases
- The brief is limited to 2 000 characters; a longer one is refused with a sentence saying how long it was.
- If the bundled `rules/` folder is missing, creating a chip fails with "Reinstall the extension" rather than sending a chip that points at a file that does not exist.
- If `RULES.md` cannot be refreshed when sending a revision (a file lock), the earlier copy stays and the message still goes out.
- The chat id typed into a `/design` command is not stored with the design: the link to a chat is made once the user actually sends a message (reconciliation).
- Nothing in `.chamber/` is ever versioned, exported or edited by the agent.

## Where it lives
`src/shared/agent/**` (builders), `src/service/discovery.ts` (project scan), `src/service/routes/{chat,presets}.ts` (HTTP routes and the creation hook), `rules/**` (the shipped text, read at runtime from the extension folder). Sample outputs: `test/agent/__snapshots__/`.
