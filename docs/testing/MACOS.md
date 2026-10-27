# Hand-testing Design Chamber on macOS

A click-through for a Mac laptop. Background and evidence: [PLATFORMS.md](PLATFORMS.md).
Paths below use `~` for your home folder and `<you>` for your user name.

## Prerequisites
- **OpenChamber desktop ≥ 2.5.0** (dmg). The extension's local service runs on OpenChamber's own
  built-in Node (24.x) — you do **not** need Node unless you build from source.
- **A Chromium browser for thumbnails** (optional — without one the list shows live mini-previews):
  Google Chrome, Chrome Canary, Chromium, Microsoft Edge or Brave, in `/Applications` or
  `~/Applications`.
- Building from source only: Node ≥ 22.18 (`brew install node@22` or nodejs.org), git.

## Install — pick one

**A. Release zip**
1. Get `design-chamber-<version>.zip` (the same zip for every OS; `npm run build && npm run pack`).
   Safari may unzip downloads automatically — if it does, use the folder with "Add from folder".
2. OpenChamber → Settings → Extensions → **Add from zip** → choose the zip → approve the requested
   capabilities (prompt, sessions, local service).

**B. From source**
1. `git clone <repo-url> ~/src/design-chamber && cd ~/src/design-chamber`
2. `npm ci && npm run build` (optional: `npm run check` — all gates)
3. OpenChamber → Settings → Extensions → **Add from folder** → `~/src/design-chamber` → approve.
   Keep the clone **outside** `~/Documents`, `~/Downloads` and `~/Desktop` if you can — those
   need a privacy grant (below) before OpenChamber may read them.
4. After a later rebuild: toggle the extension off and on in Settings → Extensions.

## Where things live
| What | Where |
|---|---|
| Designs (default) | `~/Documents/Designs` |
| Exports | `~/Downloads`, else `<designs>/.exports/` |
| Settings | `~/Library/Application Support/Design Chamber/settings.json` |
| Service log | JSON lines on the service's stderr; OpenChamber keeps the last ~2 000 characters and shows them if the service fails to start. OpenChamber's own log: Help → Show diagnostics (Cmd+Shift+L), or `~/Library/Logs/<OpenChamber app folder>/` (electron-log default — verify) |

## First thing: the Files and Folders prompt
The first time Design Chamber touches `~/Documents/Designs`, macOS should ask "**OpenChamber**
would like to access files in your Documents folder". Click **Allow**. If you clicked Don't Allow
(or no prompt appeared), the designs list shows a sentence telling you to open System Settings →
Privacy & Security → Files and Folders and turn on "Documents Folder" for OpenChamber — that is
expected; turn it on, then press Try again. Exports ask the same for **Downloads**. Record which
prompts you saw.

## Click-through (mirrors `documentation/smoke/REPORT.md`)
Fill in the Result column (PASS / FAIL / NOT RUN) and a note. Screenshots help for any FAIL.

| # | Do | Expected |
|---|---|---|
| 0 | (Optional, to test the message) Before the first run, turn **off** "Documents Folder" for OpenChamber in Files and Folders, then open the rail | The list shows the Files and Folders sentence, not an empty list; after turning it on, Try again lists designs |
| 1 | Open the Design Chamber rail icon; switch light/dark (or System) | Empty state with a way to start; colours follow the theme live |
| 2 | Open Settings in the rail | Designs folder `~/Documents/Designs`; a browser listed (e.g. Google Chrome) or "none" with live previews |
| 3 | Type `designs/here`, then `/`, then `~`, then `~/Documents`, then `/users/<you>/documents` (other case) | Each refused with a sentence; the example path reads `/Users/you/Designs`; the re-cased home is refused too |
| 4 | In a chat: `/design a pricing page`, send | Chip attached → "Waiting for agent" → the agent writes files → the wall fills with artboards within seconds |
| 5 | Look at the designs list | Thumbnails appear (headless Chrome, no window flashes) |
| 6 | Card menu: Open, Continue in chat, Show in folder, Rename, Delete | Each works; **Show in folder opens Finder with the design folder selected** |
| 7 | Wall: pan (two-finger scroll, middle-drag if you have a mouse, `H`+drag, arrows), pinch / Ctrl+scroll zoom, ±, Fit, Shift+0 / Shift+1 | Smooth; Fit frames everything |
| 8 | Edit mode: hover outline, add 2 pins, Comments drawer, Send comments | The linked chat gets one revision message |
| 9 | Select another chat, then Send comments again | The message lands in the **linked** chat |
| 10 | Let the agent apply the revision | Wall refreshes live; a version "After agent turn" appears |
| 11 | Versions: View, Compare, Restore (confirm) | Files change back; comments kept; a "Restored" version is added |
| 12 | Play mode: click an in-design link | Navigates inside the artboard; ↺ reset appears |
| 13 | `/artifact a landing page` | Artifact viewer opens after the agent writes `index.html` |
| 14 | On an assistant message with an html code block: ⋯ → Open as artifact | The rail opens the new artifact |
| 15 | Artifact Export ▾ → ZIP, then single-file HTML | Downloads prompt (first time) → toast "Saved to ~/Downloads/<slug>.zip"; **Show in folder** reveals the file in Finder |
| 16 | Double-click the ZIP; open the HTML file in a browser offline (Wi-Fi off) | `<slug>/index.html` matches; the HTML renders with no network |
| 17 | Canvas: Export ZIP and "Export screen as HTML…" | ZIP has DESIGN.md, screens/, tokens.css (no design.json, no .versions); the screen renders offline |
| 18 | Copy ▾ → Copy HTML | "HTML copied." |
| 19 | Continue in chat | Reopens the linked session |
| 20 | Sidebar → Extension pages → Design Chamber | Full-screen page next to the rail |
| 21 | Change the folder to a fresh one (e.g. `~/Designs-test`) | List empties; "N designs remain in your earlier folder"; Switch back restores them; nothing moved |
| 22 | In Settings, set the browser path to `/nonexistent` | Refused with a sentence |
| 23 | Reset the folder to default | Back to `~/Documents/Designs` with your designs |
| 24 | Edit a design file by hand in TextEdit/VS Code while the wall is open | The wall updates within ~3 s |

## macOS things to watch
- **Privacy prompts** (Documents, Downloads, Desktop): they are for OpenChamber, not Design
  Chamber. Revoking later (System Settings → Privacy & Security → Files and Folders) should give the
  sentence from step 0, never a raw "operation not permitted".
- **iCloud "Desktop & Documents"**: if it is on, `~/Documents` lives in iCloud Drive. Designs still
  work; files not yet downloaded may load slowly. Note it if you use it.
- **Case-insensitive disk:** a folder typed in another letter case is the same folder (step 3).
- **Gatekeeper:** Chrome launched headless for thumbnails is your installed Chrome; no prompt is
  expected. If a "Chrome wants to access…" prompt appears, note it.
- **External / network volumes** (`/Volumes/...`) as the designs root may also trigger a privacy
  prompt ("Removable Volumes" / "Network Volumes").

## Reporting
Copy this into an issue or a reply:

```
Design Chamber <version or commit> · OpenChamber <version>
macOS <version> · Apple silicon / Intel · iCloud Desktop & Documents on/off
Browser for thumbnails: <path from Settings, or none>
Install: zip / folder
Privacy prompts seen: Documents yes/no · Downloads yes/no

| # | Result | Note |
|---|---|---|
| 0 |  |  |
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
