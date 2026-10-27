# The local service (designs folder, settings, live updates)

**What it does:** Design Chamber runs a small local program next to OpenChamber. The rail panel
and the full-screen page never touch files themselves; they ask this service, which reads and
writes the designs folder, notices when the chat agent changes a file, and answers renders,
versions, exports, thumbnails and agent instructions (see the other feature pages).

## How it runs
- OpenChamber starts it when the extension loads and talks to it only from this machine
  (`127.0.0.1`), with a secret token generated for that run. A request without the token is
  refused. The token is never written to a log, a design file or the panel's code.
- One process holds everything: the settings, the designs list, the change feed, uploads and the
  outbox, rendering, versions and thumbnails, and the agent-instruction routes. If it cannot start
  (no port or token from OpenChamber, an unreadable settings file location) it exits with a log
  line saying why.

## The designs folder and settings
- Designs live in `<Documents>/Designs` unless the user picks another folder in Settings.
  `<Documents>` is `~/Documents` on Windows and macOS; on Linux it is the desktop's Documents
  folder from `~/.config/user-dirs.dirs` (so a German install uses `~/Dokumente/Designs`),
  else `~/Documents`. Exports go to the matching Downloads folder the same way. The choice is
  saved in the service's own settings file: `%APPDATA%\Design Chamber\settings.json` (Windows),
  `~/Library/Application Support/Design Chamber/settings.json` (macOS),
  `${XDG_CONFIG_HOME:-~/.config}/design-chamber/settings.json` (Linux).
- On macOS, OpenChamber may need permission for Documents or Downloads (System Settings →
  Privacy & Security → Files and Folders). Until it has it, the list and exports say exactly
  that switch instead of looking empty or failing with a system error.
- Changing the folder **never moves anything**: the old folder joins a "previous folders" list
  with how many designs are still there, so the user can switch back.
- A folder that is relative, a whole drive, the user's home folder (or a folder above it),
  `Documents` itself, or inside the extension itself is refused with a sentence saying why.
- Only folders that are designs count: a folder with `design.json`, `.chamber/state.json`,
  `index.html` or a `screens/` folder. Any other folder under the designs folder is the user's
  own — never listed, counted, snapshotted or written into.
- Settings also report which browser thumbnails will use: the browser path the user set (when
  that file exists), otherwise an installed Chrome, Edge, Chromium or Brave the service found
  (on Linux also Snap and Flatpak installs), otherwise none — in which case lists show live
  mini-previews instead of thumbnails.

## Design folder names
Each design gets a folder named from its title: lowercase, accents folded, words joined with
dashes, at most 48 characters, `design` when nothing usable is left, and `-2`, `-3`… when the name
is taken. Names Windows reserves for devices (`con`, `nul`, `aux`, `prn`, `com1`–`com9`,
`lpt1`–`lpt9`) get `-design` added, because Windows cannot create such folders.

## Staying inside the designs folder
Every path the service touches — from a request, from `design.json`, from an agent-written page's
references, from the version list on disk — goes through one tested containment check: no
stepping up with `..`, no other drive or network share, no absolute paths, and no shortcut
(symlink or junction) that leads outside. Anything else is refused. Paths compare without
regard to letter case on Windows and macOS (their disks ignore case by default) and exactly on
Linux.

## Live updates
The service watches the designs folder (with a 3-second check as a backstop, because OneDrive and
network folders can miss notifications) and publishes a change feed the panel and page
long-poll: a design added or removed, its `design.json` changed, its files changed, a new
thumbnail, new versions, comments, or the folder switched. Its own bookkeeping files (`.chamber/`,
`.versions/`, the thumbnail) never show up as changes — also on OneDrive/network folders, where
only the 3-second check sees changes. On Linux, if the system's file-watch limit is reached
(or watching is unsupported), the service notes it once in its log and relies on the 3-second
check alone; nothing is shown to the user. When the agent rewrites `design.json` while the service is
merging comments into it, the service re-merges from the agent's new file instead of writing
over it. When a design folder appears and is
written to within a moment, the feed reports it once as *added* — the panel treats that as "load
everything for this design".

## Edge cases
- If the service restarts, the panel's next poll sees a new run id and reloads everything.
- A message too large for one request (an assistant message for "Open as artifact") is uploaded
  in pieces and joined by the service; unfinished uploads expire after 10 minutes.
- The outbox (a revision waiting for the right chat to be selected) holds one message for
  10 minutes and is delivered exactly once.
- "Open as artifact" leaves one open request (`DELETE /open-request` takes it, once; 2 minutes)
  so the rail opens the new artifact.
- A Designs folder that cannot be created or written is refused with a sentence chosen by the
  error code (missing drive, no permission, part of the path is a file, read-only or full drive,
  in use, path too long) — never the raw system message.
- Folder names come from the title, at most 48 characters, cut at a word boundary.
- A designs folder the service is not allowed to read shows an error with that sentence (and on
  macOS the privacy switch to turn on), not an empty list.
- Platform details (which runtime runs the service, browser discovery, Snap/Flatpak, file
  managers for "Show in folder"): `docs/testing/PLATFORMS.md`.

## Where it lives
`src/service/compose.ts` (wiring), `src/service/main.ts` (process entry), `src/service/paths.ts`
(containment and folder names), `settings.ts` / `root.ts`, `store.ts`, `watch.ts` / `changes.ts`,
`uploads.ts`, `outbox.ts`, and the routes in `src/service/routes/`. Tests: `test/service/**`
(`test/service/integration/` runs the built service end to end).
