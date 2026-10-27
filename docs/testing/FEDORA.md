# Hand-testing Design Chamber on Fedora (and Ubuntu)

A click-through for a real Fedora desktop (GNOME, Wayland — the default). Ubuntu works the same
way; where it differs it is noted. Background and evidence: [PLATFORMS.md](PLATFORMS.md).
Paths below use `~` for your home folder and `<you>` for your user name.

## Prerequisites
- **OpenChamber desktop ≥ 2.5.0** (rpm, deb or AppImage). The extension's local service runs on
  OpenChamber's own built-in Node (24.x) — you do **not** need Node unless you build from source.
- **A Chromium browser for thumbnails** (optional — without one the list shows live mini-previews):
  - Fedora: `sudo dnf install chromium` (native rpm, best choice), or Google Chrome's rpm.
  - Ubuntu: Google Chrome's `.deb` is best. Ubuntu's `chromium` / `chromium-browser` is a **Snap**;
    it works while your designs folder is inside your home folder (see "Watch for").
  - Flatpak Chrome/Chromium is found too, but needs access to the designs folder:
    `flatpak override --user --filesystem=~/Documents/Designs org.chromium.Chromium`
    (or `com.google.Chrome`).
- **"Show in folder"** uses `xdg-open`, then `gio open`, then the file manager over D-Bus — all present
  on a stock Fedora Workstation / Ubuntu Desktop.
- Building from source only: Node ≥ 22.18 (`sudo dnf install nodejs npm`), git.

## Install — pick one

**A. Release zip**
1. Get `design-chamber-<version>.zip` (built with `npm run build && npm run pack` on any OS — the
   zip is the same for every OS).
2. OpenChamber → Settings → Extensions → **Add from zip** → choose the zip → approve the requested
   capabilities (prompt, sessions, local service).

**B. From source**
1. `git clone <repo-url> ~/src/design-chamber && cd ~/src/design-chamber`
2. `npm ci && npm run build` (optional: `npm run check` — all gates, about 2 minutes)
3. OpenChamber → Settings → Extensions → **Add from folder** → `~/src/design-chamber` → approve.
4. After a later rebuild: toggle the extension off and on in Settings → Extensions.

## Where things live
| What | Where |
|---|---|
| Designs (default) | `<Documents>/Designs` — `~/Documents/Designs`, or the translated folder from `~/.config/user-dirs.dirs` (e.g. `~/Dokumente/Designs`) |
| Exports | your Downloads folder (from the same file), else `<designs>/.exports/` |
| Settings | `${XDG_CONFIG_HOME:-~/.config}/design-chamber/settings.json` |
| Service log | JSON lines on the service's stderr; OpenChamber keeps the last ~2 000 characters and shows them if the service fails to start. OpenChamber's own log: Help → Show diagnostics (exact folder: electron-log default under `~/.config/<OpenChamber app folder>/logs/` — verify) |

## Click-through (mirrors `documentation/smoke/REPORT.md`)
Fill in the Result column (PASS / FAIL / NOT RUN) and a note. Screenshots help for any FAIL.

| # | Do | Expected |
|---|---|---|
| 1 | Open the Design Chamber rail icon; switch OpenChamber between light and dark | Empty state with a way to start; colours follow the theme live |
| 2 | Open Settings in the rail | Designs folder shows `<Documents>/Designs` (translated name if your desktop uses one); a browser is listed (e.g. `/usr/bin/chromium`) or "none" with live previews |
| 3 | Type `designs/here`, then `/`, then `~`, then `~/Documents` (or your translated Documents) as the folder | Each refused with a sentence; the example path reads `/home/you/Designs` (not a `C:\` path) |
| 4 | In a chat: `/design a pricing page`, send | Chip attached → "Waiting for agent" → the agent writes files → the wall fills with artboards within a few seconds of each write |
| 5 | Look at the designs list | Thumbnails appear (or live mini-previews when no browser). With a Snap/Flatpak browser they must still appear |
| 6 | Card menu: Open, Continue in chat, Show in folder, Rename, Delete | Each works; **Show in folder opens GNOME Files (Nautilus) at the designs folder** |
| 7 | Wall: pan (wheel, middle-drag, `H`+drag, arrows), Ctrl+wheel zoom, ±, Fit, Shift+0 / Shift+1 | Smooth; Fit frames everything |
| 8 | Edit mode: hover outline, add 2 pins, Comments drawer, Send comments | The linked chat gets one revision message |
| 9 | Select another chat, then Send comments again | The message lands in the **linked** chat |
| 10 | Let the agent apply the revision | Wall refreshes live; a version "After agent turn" appears |
| 11 | Versions: View, Compare, Restore (confirm) | Files change back; comments kept; a "Restored" version is added |
| 12 | Play mode: click an in-design link | Navigates inside the artboard; ↺ reset appears |
| 13 | `/artifact a landing page` | Artifact viewer opens after the agent writes `index.html` |
| 14 | On an assistant message with an html code block: ⋯ → Open as artifact | The rail opens the new artifact |
| 15 | Artifact Export ▾ → ZIP, then single-file HTML | Toast "Saved to ~/Downloads/<slug>.zip" (your Downloads folder); **Show in folder** opens Files with the file's folder |
| 16 | Unzip the ZIP (`unzip <slug>.zip`); open the HTML file in a browser offline | `<slug>/index.html` matches; the HTML renders with no network |
| 17 | Canvas: Export ZIP and "Export screen as HTML…" | ZIP has DESIGN.md, screens/, tokens.css (no design.json, no .versions); the screen renders offline |
| 18 | Copy ▾ → Copy HTML | "HTML copied." |
| 19 | Continue in chat | Reopens the linked session |
| 20 | Sidebar → Extension pages → Design Chamber | Full-screen page next to the rail |
| 21 | Change the folder to a fresh one (e.g. `~/Designs-test`) | List empties; "N designs remain in your earlier folder"; Switch back restores them; nothing moved |
| 22 | In Settings, set the browser path to `/nonexistent` | Refused with a sentence |
| 23 | Reset the folder to default | Back to `<Documents>/Designs` with your designs |
| 24 | Edit a design file by hand in a text editor while the wall is open | The wall updates within ~3 s |

## Fedora/Ubuntu things to watch
- **Translated XDG folders:** with a non-English desktop the default root is inside the translated
  Documents folder. If `~/.config/user-dirs.dirs` is missing, `~/Documents/Designs` is used.
- **Snap/Flatpak browser:** thumbnails are captured through a work folder inside the design's
  hidden `.chamber/` folder (the browser can't see `/tmp`). If thumbnails stay "failed" with a
  Snap Chromium and a designs folder **outside** your home folder, run
  `sudo snap connect chromium:removable-media` or install a native browser.
- **Show in folder:** if nothing opens, note your desktop (GNOME/KDE/other, Wayland or X11) —
  OpenChamber hands extensions no display variables, so Design Chamber reaches the file manager
  via D-Bus; an X11-only file manager may not open. The error names the file path.
- **Many designs / inotify limit:** if `cat /proc/sys/fs/inotify/max_user_watches` is small, live
  updates may come from the 3 s poll only (still live, just slower). Nothing is shown to you.
- **SELinux** (Fedora, enforcing): not expected to matter — everything runs as your user in your
  home folder. If something fails only on Fedora, check `sudo ausearch -m avc -ts recent`.
- **AppImage:** works the same; the service runs on the AppImage's bundled runtime.

## Reporting
Copy this into an issue or a reply:

```
Design Chamber <version or commit> · OpenChamber <version> (rpm/deb/AppImage)
Fedora <release> / Ubuntu <release> · GNOME/KDE · Wayland/X11 · locale <LANG>
Browser for thumbnails: <path from Settings, or none> (native/Snap/Flatpak)
Install: zip / folder

| # | Result | Note |
|---|---|---|
| 1 |  |  |
| 2 |  |  |
| 3 |  |  |
| 4 |  |  |
| 5 |  |  |
| 6 |  |  |
| 7 |  |  |
| 8 |  |  |
| 9 |  |  |
| 10 |  |  |
| 11 |  |  |
| 12 |  |  |
| 13 |  |  |
| 14 |  |  |
| 15 |  |  |
| 16 |  |  |
| 17 |  |  |
| 18 |  |  |
| 19 |  |  |
| 20 |  |  |
| 21 |  |  |
| 22 |  |  |
| 23 |  |  |
| 24 |  |  |
```
