# Platform support — Windows, macOS, Ubuntu, Fedora

What Design Chamber does differently per OS, why, and the evidence. Hand-test guides:
[FEDORA.md](FEDORA.md) (also the reference for Ubuntu) and [MACOS.md](MACOS.md).
CI runs `npm run check` on ubuntu-latest, windows-latest and a `fedora:latest` container
(`.github/workflows/ci.yml`). macOS is not in CI (runner cost) — run `npm run check` on a Mac.

## 1. Which runtime runs the extension service (`runtime: "host"`)

Investigated in the read-only OpenChamber source (`~/Documents/GitHub/openchamber`, 2.5.2,
commit `0056bf6a9`):

| Fact | Evidence |
|---|---|
| The host spawns the service as `spawn(process.execPath, [entry], { env, stdio: pipe })` — **the host's own executable**, not a system Node. | `packages/web/server/lib/guests/service.js:487-492` |
| It sets `ELECTRON_RUN_AS_NODE=1`, so inside the desktop app that executable behaves as plain Node. | `service.js:470-475` |
| The desktop app runs the OpenChamber server **in-process** in Electron's main process, so `process.execPath` is the OpenChamber/Electron binary. | `packages/electron/main.mjs:1629-1631` (`import('@openchamber/web/server/index.js')` → `startWebUiServer`) |
| Electron version: `^44.9.3` (same for Windows, macOS, Linux builds). | `packages/electron/package.json:22` |
| **Measured:** the installed desktop app run with `ELECTRON_RUN_AS_NODE=1 OpenChamber.exe -e …` reports **Node 24.22.0**, Electron 44.9.3. Linux/macOS builds ship the same Electron. | run on the dev machine, 2026-10-27 |
| The headless/web server (`openchamber serve`) runs on system Node: `#!/usr/bin/env node`, `engines.node >= 24.14.0`. Only a developer running the server with `bun server/index.js` would make the service run under Bun (dev only, not supported here). | `packages/web/bin/cli.js:1`, `packages/web/package.json:14-16` |
| The service env is an allowlist: PATH, HOME, USER, LOGNAME, SHELL, TMPDIR/TEMP/TMP, TZ, LANG/LANGUAGE/LC_*, **XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_RUNTIME_DIR**, and the Windows profile vars. **No DISPLAY, WAYLAND_DISPLAY, DBUS_SESSION_BUS_ADDRESS or XDG_CURRENT_DESKTOP.** | `service.js:556-562` |
| On macOS/Linux the desktop app merges the user's login-shell env (PATH) into its own before starting the server, so the service PATH includes e.g. `/opt/homebrew/bin`. | `packages/electron/main.mjs:1525-1548` |
| macOS build: hardened runtime, **not App-Sandboxed** ("Intentionally NOT sandboxed"), so macOS privacy (TCC) applies to OpenChamber as the responsible app. | `packages/electron/package.json:127-130`, `resources/entitlements.mac.plist:6` |
| Linux packages: AppImage, deb, rpm. | `packages/electron/package.json:145-150` |

**Consequences**
- `fs.watch(root, { recursive: true })` is supported on Linux from Node 20 and on Node 24 it
  works; it is implemented by watching every folder with inotify, so a huge root can hit the
  per-user inotify limit (`ENOSPC`). macOS uses FSEvents; Windows ReadDirectoryChangesW.
- `child_process` behaves like Node 24 everywhere; on Windows a `.cmd`/`.bat` cannot be spawned
  without a shell (we only spawn `.exe` and Unix executables).
- The XDG variables we need are passed; desktop-session variables are not (see §5).

## 2. Folders

| | Windows | macOS | Linux (Ubuntu, Fedora) |
|---|---|---|---|
| Default designs root | `~\Documents\Designs` | `~/Documents/Designs` | `<XDG Documents>/Designs` — from `${XDG_CONFIG_HOME:-~/.config}/user-dirs.dirs`, else `~/Documents/Designs` |
| Exports | `~\Downloads` | `~/Downloads` | XDG Download folder, else `~/Downloads`; `<root>/.exports/` when missing |
| Settings file | `%APPDATA%\Design Chamber\settings.json` | `~/Library/Application Support/Design Chamber/settings.json` | `${XDG_CONFIG_HOME:-~/.config}/design-chamber/settings.json` |

`user-dirs.dirs` is parsed directly (`src/service/user-dirs.ts`) instead of spawning
`xdg-user-dir`: that command is a shell script sourcing the same file. `$HOME`-relative and
absolute values are read; a value equal to `$HOME` means "disabled" and falls back. A
translated Documents folder (e.g. `~/Dokumente`) is refused as a designs root just like
`~/Documents` (it holds the user's own files). Existing roots are never moved.

## 3. Path comparison (containment)

`src/service/paths.ts` `foldsCase`: case-insensitive on win32 **and darwin**, exact on Linux.
macOS's default APFS/HFS+ volumes ignore case, so an exact comparison would let
`/users/you` slip past the "your home folder" refusal or make one root look like two.
Trade-off: on an opt-in case-sensitive APFS volume, a symlink inside the root to a sibling folder
whose path differs from the root only by letter case would count as inside — judged
acceptable (contrived, needs an agent-made symlink). Unicode normalisation (NFD) is not folded.

## 4. Thumbnails (headless browser)

Discovery order (`src/service/chrome.ts`), after the user's own setting:
- **Windows:** literal Program Files paths, `%LOCALAPPDATA%` Chrome, then Edge.
- **macOS:** Google Chrome, Google Chrome Canary, Chromium, Microsoft Edge, Brave Browser — each
  in `/Applications`, then `~/Applications`.
- **Linux:** `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`,
  `microsoft-edge`, `microsoft-edge-stable`, `brave-browser` on PATH, then in `/usr/bin` and
  `/usr/local/bin` (a minimal PATH must not hide them), then `/snap/bin/chromium` and the Flatpak
  launchers `com.google.Chrome`, `org.chromium.Chromium`, `com.microsoft.Edge`,
  `com.brave.Browser` in `/var/lib/flatpak/exports/bin` and `~/.local/share/flatpak/exports/bin`.

**Snap/Flatpak:** these browsers run with a private `/tmp`, so a screenshot written to the
service's temp folder never appears. On Linux the capture's work folder (Chrome profile + raw
PNG) is therefore created in the design's own `.chamber/` folder and removed afterwards (stale
ones older than 10 minutes, left by a killed run, are cleared). Why there: the browser must read
the page from the design folder anyway, so whatever can read the source can write beside it;
`.chamber/` is ignored by the watcher, versions and exports. It applies to every Linux browser
because Ubuntu's `/usr/bin/chromium-browser` is itself a Snap wrapper. Limits: Snap's `home`
interface does not reach hidden folders directly in `~` or folders outside `~` — a designs root
like `/mnt/data/Designs` needs `snap connect chromium:removable-media` or a native browser; a
Flatpak browser needs access to the designs folder (`flatpak override --user
--filesystem=~/Documents/Designs org.chromium.Chromium`). Win32/darwin keep the OS temp folder.

`--headless=new` needs no display (no DISPLAY is passed anyway). `--no-sandbox` is added only on
Linux when the service runs as root (containers); never otherwise.

**Thumbnail size on Linux is 640×400, not 320×200.** Chromium on Linux clamps
`--force-device-scale-factor` at 0.5 (measured, Chromium 156 on Fedora 44: 0.25 → 640×400, 0.5 →
640×400, 1 → 1280×800; Chrome 156 on Windows gives 320×200). The list shows the image scaled to
its card, so only the bytes grow (4× pixels, still tens of kB). Tests accept 640×400 on Linux only.

Tests: a Snap/Flatpak browser cannot read the OS temp folder the tests create designs in; on
such a machine set `DC_TEST_CHROME` to a native install or let the browser tests skip.

## 5. "Show in folder"

Spawned with an argv array, never a shell (`src/service/reveal.ts`):
- Windows `explorer.exe /select,<path>`; macOS `open -R <path>`.
- Linux, each tried only if the previous could not start or exited non-zero:
  `xdg-open <folder>` → `gio open <folder>` → `gdbus call --session … org.freedesktop.FileManager1.ShowItems
  ['file:///…']` (Nautilus, Dolphin, Nemo, Caja implement it). The file URI has `'` percent-encoded
  so the D-Bus literal cannot be broken.
- Because the host passes no DISPLAY/WAYLAND_DISPLAY/DBUS_SESSION_BUS_ADDRESS, the openers get
  `DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus` and `WAYLAND_DISPLAY=wayland-0` when
  those sockets exist. X11 DISPLAY is not guessed (no X authority file is passed either).
  D-Bus-activated file managers (GNOME Files, Dolphin) work this way; an X11-only file manager may not.
- If nothing works the user gets a sentence with the file's path to open it by hand.

## 6. macOS privacy (TCC)

OpenChamber is not sandboxed but macOS still guards `~/Documents`, `~/Downloads` and `~/Desktop`
per app. The service is OpenChamber's child, so the prompt (and the switch in System Settings →
Privacy & Security → Files and Folders) is for **OpenChamber**. When access is denied (EPERM/EACCES
under those folders) the list, folder change, design creation and export answer a sentence naming
the exact switch ("Documents Folder" etc.) instead of an empty list or a system error
(`folderErrorSentence`, `src/service/root.ts`). OpenChamber's Info.plist sets no
`NSDocumentsFolderUsageDescription`; the system prompt then shows without a purpose line.

## 7. Watching

Fast path plus the 3 s poll backstop on every OS. Windows and macOS use `fs.watch(root,
{ recursive: true })`. **Linux uses `src/service/folder-watch.ts`: one plain `fs.watch` per
folder.** Found while running the suite in Linux containers: Node's recursive mode on Linux
(22.23 and 24.22) keeps a watch on each *file* it found, so a `design.json` replaced by rename
(the store's atomic write, version restore, many agents) silently stops reporting — the agent's
next in-place write raised no event and the design.json re-merge waited for the 3 s poll (the
"re-merged within 1 s" acceptance test failed). A folder watch reports its entries by name
whatever their inode. Dot folders (`.versions/`, `.chamber/`, `.trash/`) and top-level folders
that are not designs are not watched (their events are ignored anyway), keeping the inotify
count to roughly 1 + designs × (1 + screens/ + assets/ folders). If the watch cannot work on
this root — `ENOSPC` (inotify limit), `ENOSYS`, `ERR_FEATURE_UNAVAILABLE_ON_PLATFORM` — the service
logs `watch.poll-only` once (info) and stops retrying until the root changes; the poll keeps the
list live within ~3 s. Nothing is shown to the user. To raise the Linux limit:
`sysctl fs.inotify.max_user_watches=524288` (Fedora/Ubuntu defaults are usually far higher on
recent kernels).

## 8. Files we write or the agent reads

Text we generate is joined with `\n`; bundled rules files are read and normalised to LF
(`src/service/routes/presets.ts`), so RULES.md and the chip are the same bytes on every OS even
from a CRLF checkout. `.gitattributes` keeps the repo LF. Paths shown to the agent use the
platform's own separator (they are real paths on that machine).

## 9. Release zip

`npm run build && npm run pack` → one `design-chamber-<version>.zip` for every OS: `package.json`,
`LICENSE`, `README.md`, `dist/**` (IIFE guests and the ESM service — plain JS, no native modules),
`rules/**`; names `/`-separated and sorted; `.DS_Store`/`Thumbs.db`/`desktop.ini` excluded. Checked
on Windows 2026-10-27: 22 entries, top level `LICENSE, README.md, dist, package.json, rules`, no
backslash names, no CRLF text files.

## 10. Tests per OS

Local evidence before CI existed (2026-10-27, Docker on the Windows dev machine):

| Where | Node | Tests | Pass | Fail | Skipped |
|---|---|---|---|---|---|
| Windows 11 (host) | 24.21.0 | 561 | 560 | 0 | 1 (chmod permission test, posix-only) |
| `node:22` (Debian), non-root, no browser | 22.23.4 | 561 | 551 | 0 | 10 (9 browser tests, 1 win32-only) |
| `fedora:latest` (Fedora 44), root, no browser — CI before 2026-10-27 (CI now: Chromium, non-root) | 22.23.1 | 561 | 550 | 0 | 11 (+ chmod test: root reads anything) |
| `fedora:latest` + `dnf install chromium` (156), root — the 24 browser/e2e tests | 22.23.1 | 24 | 24 | 0 | 0 |

The Chromium run first failed: the tests' own browser launches lacked `--no-sandbox` as root,
and thumbnails came out 640×400 (above). Both are handled in the test helpers
(`testBrowserFlags`, `isLaptopThumbSize`); the product capture itself worked as root.

Also fixed on the way, both test-only: `changes.test.ts` (the hub's unref'd wait timers let
the Linux test process exit mid-wait) and the reveal test's upper-cased path (a case-sensitive
disk has no such file).

- Windows-only cases are guarded: `chmod`-based permission test (posix, non-root), the missing-drive
  settings test (win32). Junction-creating tests pass `'junction'`, which Node ignores on posix
  (a plain symlink is made).
- The system-unzip ZIP test uses PowerShell `Expand-Archive` on Windows, Info-ZIP `unzip` on
  Linux/macOS, else `tar` (bsdtar); skips with a reason when neither reads ZIP.
- Browser tests use the service's own discovery and skip with a reason when no browser is found
  (the Fedora CI container).
- Platform rules (paths, folders, browser lists, reveal plans, TCC sentences, capture args) are
  unit-tested with an injected platform, so they run on every OS.
