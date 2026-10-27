# Design Chamber — live smoke click-through (SPEC §15.3)

Run: 2026-10-27, qa-tester. First pass on `dbf408f`; restore and settings re-checked on the rebuilt `3fca0a8`
(review fixes: safer restore, design.json merge, root-safety, only real design folders listed).
`npm run build` and `npm test` (513 pass / 0 fail) were run on `3fca0a8`.

## Environment
- Windows 11, the user's running OpenChamber desktop app; its server on `http://127.0.0.1:57123`, theme variant dark.
- Design Chamber 0.1.0, source `path`, capabilities granted `prompt, sessions, service` (host service runtime).
- Chat agent for the designs: DeepSeek V4.1 Flash 1017 (Alibaba token plan); revision turns on Qwen3.8 Max. The chat had
  "accept everything" permissions, so the OpenCode `external_directory` prompt was **not** exercised.
- Headless thumbnails: Chrome 156 (detected `C:\Program Files\Google\Chrome\Application\chrome.exe`).
- Designs root during the run: `C:\Users\you\AppData\Local\Temp\dc-smoke-designs` (scratch). **Reset to the default at the end** (see Final state).
  The repo-local `.smoke/Designs` the brief suggested is refused by Settings ("inside the Design Chamber extension itself") — correct behaviour, so a temp folder was used. `.smoke/` and `.openchamber/` are in `.gitignore` anyway.

## Install method (repeatable)
The extension was **already installed** from the folder (found in `GET /api/guests`: `source:"path"`, enabled, granted). No fresh install was needed. To repeat:
1. `npm run build` in the repo.
2. OpenChamber → Settings → Extensions → Add from folder → `C:\Users\you\Documents\GitHub\design-chamber` → approve (prompt, sessions, local service).
   API equivalent the UI uses: `POST /api/guests {"path":"<repo>"}` then `PUT /api/guests/design-chamber/capabilities {"granted":["prompt","sessions","service"]}`.
3. After a rebuild: reload by `PUT /api/guests/design-chamber/enabled {"enabled":false}` then `{"enabled":true}` (restarts the local service; designs and settings survive).

How the UI was driven: the desktop window cannot be scripted, so a separate **headless Chrome** (`--remote-debugging-port=9333`) opened the same OpenChamber
web UI at `127.0.0.1:57123` and `documentation/smoke/tools/cdp-driver.mjs` (small CDP driver, ~8 kB, QA tooling) clicked, typed and took the screenshots,
including inside the sandboxed guest iframes. Chat state and files are the real ones. Headless Chrome follows the OS colour scheme, so light mode was shown by
emulating `prefers-color-scheme: light` (OpenChamber is on "System" and follows it); no OpenChamber setting was changed.

## Results

| # | Step | Result | Evidence |
|---|---|---|---|
| 1 | Rail icon, empty state, dark/light repaint live | PASS | 04, 05 (empty), 11, 32, 33 |
| 2 | Settings: folder validation (relative path, missing drive, inside-extension, non-folder), copy snippet, Chrome override test | PASS | 01, 02, 03, 20 |
| 3 | `/design` → chip attached → send → "Waiting for agent" → agent reads RULES.md, writes DESIGN.md/tokens.css/screens, the wall fills with 4 artboards (no "go" answer was needed) | PASS | 06, 07, 18, 34 |
| 4 | Thumbnails appear in list (headless Chrome) | PASS (see m2: scheme mismatch) | 08, 31, 32, 33 |
| 5 | Library cards, card menu (Open, Continue in chat, Reveal, Rename, Delete…) | PASS | 08, 09, 31 |
| 6 | Wall: pan both axes (wheel, middle-drag, `H`+drag, arrows), Ctrl+wheel zoom to cursor, ± and Fit, Shift+0 / Shift+1, viewport chips | PASS | 34, 35 |
| 7 | Edit hover outline, 2 pins, Comments drawer (Open/Sent/Resolved), Send comments → linked chat gets one revision message | PASS | 10, 29, 30 |
| 8 | Send from a different selected chat (outbox path): message lands in the **linked** chat | PASS | (text of the message verified via session API) |
| 9 | Agent applies the revision, wall refreshes live, version "After agent turn" | PASS for turn 1 (v24); turn 2 only got an auto version (m5) | 13 |
| 10 | Versions: View, Compare (split v16 ⟷ current, changed-file list), Restore with confirm | PASS | 14, 15, 16, 17 |
| 11 | **Re-check on 3fca0a8:** Restore v16 then Restore v35 | PASS — home.html and DESIGN.md changed on restore; comments (3) kept; restoring v35 gave **byte-identical** files to before (md5 of 4 files); new "Restored" version added; no files lost | (md5 in run log) |
| 12 | Play mode: in-design link navigates inside the artboard, ↺ reset appears | PASS | (seen in run; no saved shot) |
| 13 | `/artifact` → design created, "Waiting for agent" → artifact viewer | PASS | 18, 23 |
| 14 | Message action ⋯ → Open as artifact (html code block) | **PARTIAL — see M1** | 21 |
| 15 | Artifact viewer Export ▾: ZIP and single-file HTML to `~/Downloads`, toast with path + Show in folder | PASS | 23, 24 |
| 16 | Exported files check: ZIP unzips to `<slug>/index.html` identical to source; single-file HTML has 0 relative refs, renders identically when opened from `file://` in a fresh headless Chrome (no network refs in the file) | PASS | 26 |
| 17 | Canvas: Export ZIP (DESIGN.md, screens/, tokens.css; no design.json/.versions) and "Export screen as HTML…" picker; exported screen renders offline | PASS | 27, 28 |
| 18 | Copy ▾ → Copy HTML ("HTML copied.") | PASS | 25 |
| 19 | Continue in chat reopens the linked session | PASS | 19 |
| 20 | Full-screen page via sidebar palette icon (Extension page) next to the rail | PASS | 34, 35 |
| 21 | **Re-check on 3fca0a8:** folder safety — home dir, `Documents`, `C:\` refused with a sentence; `C:\Windows` refused (not writable) | PASS (raw-error wording: m3) | 36 |
| 22 | Change root to an empty folder → list empties, "3 designs remain in your earlier folder", Switch back restores the 3 designs; nothing moved | PASS | 37 |
| 23 | Chrome path nonsense → thumbnails fall back to live mini-frames | NOT RUN — Test and save rejects a nonsense path, so it cannot be saved (20) | 20 |
| 24 | Setting reset to default and verified | PASS | `GET /settings` → `root == defaultRoot` |

Downloads: the four files exported (2 zip, 2 html) were deleted afterwards; `~/Downloads` listing is identical to before.

## Findings

### Major
**M1 — "Open as artifact" gives no visible response when the rail is closed.**
Repro: in a chat, an assistant message with a ```html block → ⋯ → Open as artifact, with the Design Chamber rail panel closed (the usual state).
Expected (BRIEF): the artifact opens in the rail viewer, or at least a visible confirmation. Actual: the menu closes and nothing appears (no panel, no toast reaches the user);
the artifact **was** created in the Designs folder and appears in the library, and the rail shows it only once the user opens the panel by hand. Looks like "the button did nothing".
Probably the guest toast renders in the hidden rail iframe. Suggested owner: fullstack-developer / ui-ux-developer — send a host notification or ask the user to open the panel. Shot: 21.

### Minor (logged in `documentation/known-issues.md`)
- **m2 / KI-3** Thumbnails follow the OS scheme (dark on this PC) while artboards render light, so a design with `prefers-color-scheme: dark` has a dark card and a light wall. Shots 08, 31.
- **m1 / KI-4** With the Versions/Comments drawer open in a ~580 px page (page beside the open rail) Fit gives 6 %.
- **m3 / KI-5** Folder errors show raw Node text ("EPERM … open 'C:\Windows\.dc-write-probe-…'", "ENOENT … mkdir '\\?\Z:\…'").

### Minor / nits not logged
- **m4** Folder name and first title are cut at 48 characters mid-word (`a-landing-page-and-a-pricing-screen-for-a-neighb`) until the agent renames the title (the folder keeps the cut).
- **m5 (unverified cause)** The first revision turn produced a version with reason `turn` ("After agent turn"); the second (comment sent from another chat, outbox path) only produced `auto` versions. The brief wants a snapshot per agent turn.

### FYI
- Auto versions pile up quickly while an agent writes: 35 versions in about two hours (`auto` every ~30 s during writes).
- Send comments from a different chat moves the app to the linked chat.
- Opening a canvas the first time hung my CDP driver for 60–100 s twice; not reproduced later (probably a headless/CDP artifact; flagged in case someone sees a slow first open).
- OpenCode `external_directory` permission prompt not exercised (session had accept-everything).

## Final state
- Design Chamber **installed and enabled** (version 0.1.0, rebuilt from `3fca0a8`).
- Designs folder setting: **default `C:\Users\you\Documents\Designs`** (verified via `GET /settings`; the folder does not exist yet and is created on first write).
- The library therefore starts empty and shows the notice "3 designs remain in your earlier folder `…\Temp\dc-smoke-designs`" with **Switch back**; that is the scratch smoke set (Ferndale canvas, two artifacts) — Switch back shows them, or delete the folder.
- Headless Chrome and the driver were stopped; their temp profiles removed.

## Best README shots
Hero: `34-wall-hero-dark.png` (canvas wall: 2 screens × Laptop+Phone, 3 pins), `35-wall-hero-light.png`.
Gallery: `10-wall-pins-comments-drawer-dark.png`, `30-wall-comments-drawer-light.png`, `15-version-compare-dark.png`, `13-wall-versions-drawer-light.png`,
`23-artifact-export-menu-dark.png`, `31-library-light.png` / `08-library-dark.png`, `32-rail-list-three-designs-light.png` / `33-…-dark.png`, `36-settings-home-folder-refused-dark.png`.
Note: `31-library-light.png` shows the dark-thumbnail mismatch (m2); prefer `08` for dark and re-shoot light after KI-3 is fixed if the thumbnails matter.

## Fix round (2026-10-27)
Fixes for M1, m1–m5 and KI-2, re-checked in the same live app (headless Chrome + `tools/cdp-driver.mjs`, rail beside the chat). `npm run check`: typecheck, build and 526 tests pass, 0 fail.

| Finding | Cause | Fix | Live check |
|---|---|---|---|
| **M1** Open as artifact does nothing | The action was `mode: "open"`: the host parks the message for the rail and calls `openContextSurface`, which **toggles**. With the rail open, the click closed it. With the rail closed, the first click after loading a chat did not open it, and the parked message was lost. | The action is now `mode: "background"`. The hidden background frame saves the artifact with `open: true`, which leaves a one-time open request in the service (`DELETE /open-request` takes it; it expires after 2 minutes). It then calls `openSurface` (opens and never toggles) and shows a host toast: *Saved as artifact "…"*, or *…open Design Chamber to see it* when there is no side panel. The rail takes the request when it mounts, or on an `added` change if it is already open, and shows the viewer. | PASS. With the rail closed (on the list) and with it open: the rail opens on the new artifact's viewer and the toast appears. Screenshots are kept outside the repo. |
| m2 / KI-3 thumbnails dark | Headless Chrome followed the OS dark scheme. | `--blink-settings=preferredColorScheme=1` (light), checked on Chrome 156 (without the flag: blue/dark; with it: red/light). The scheme is stored in `thumb.json`, so older PNGs are taken again. | Covered by a test with the real browser, which fails without the flag. |
| m1 / KI-4 Fit 6 % with a drawer open | The 360 px dock squeezed the wall to about 100 px. | Below 720 px the dock lies over the wall's right half (`min(360px, 50%)`). Fit aims at the uncovered part (`fitArea`), or uses the whole wall when less than 240 px is left. It refits when the dock opens or closes. | PASS. In the 576 px page with Versions open, Fit gives 19 % (was 6 %) and the artboard is fully visible beside the drawer. |
| m3 / KI-5 raw Node errors | `root.ts` added `error.message` to the sentence. | `folderErrorSentence` maps ENOENT, EACCES/EPERM, ENOTDIR/EEXIST, EROFS, ENOSPC, EBUSY, ENAMETOOLONG, EINVAL and EIO to sentences. | Unit tests, plus a real missing drive and a path under a file. |
| m4 names cut mid-word | `slugify` sliced at 48. | Cut at the last word boundary within 48; a hard cut only for one very long word. Long folder paths in the UI (earlier-folder banner, Settings) are shortened in the middle, keeping the drive and the last folders, with the full path as a tooltip (`middlePath`). | Unit tests. |
| m5 second turn: only `auto` versions | (1) The turn snapshot was deduped by tree hash: the quiet-period auto snapshot had already captured the same files. (2) `onSessionLifecycle` covers only the frame's own session. It also reports `completed` for any idle chat the frame shows (mount, chat switch), not just a finished turn. | (1) A turn whose files match an `auto` version less than 30 minutes old relabels it as "After agent turn". (2) A linked chat that is not selected gets its turn snapshot when the project's sessions list shows it go from working to idle. A lifecycle `completed` counts only after a `started` seen in the same frame, so a chat switch no longer looks like a turn. | Unit and service tests. Not re-run with a live agent turn. |
| KI-2 duplicate revision after mark-sent fails | The flow rejected after the prompt had already been delivered. | mark-sent is retried once. If it still fails, the result is still `sent`, with `markFailed`, and the drawer (or rail) shows "Sent — but the comments could not be marked as sent…". | Unit test (fails on the old flow). |

Ready state: the extension was rebuilt from this commit, reloaded (enabled → off → on) and is enabled with `prompt, sessions, service` granted. In `%APPDATA%\Design Chamber\settings.json` the two smoke scratch roots (`…\Temp\dc-smoke-designs`, `…\Temp\dc-smoke-alt`) and the smoke's nonsense browser override (`C:\nope\not-chrome.exe`) were removed. The file is now `{ "version": 1 }`, so the root is the default `~\Documents\Designs`. Both scratch folders were deleted: one held the 3 smoke designs, the other was empty. The artifacts made during this round were deleted, so `~\Documents\Designs` is empty and the library shows no "earlier folder" notice.

Open for the architect: `docs/SPEC.md` §5 (manifest, the action `mode`), §7 (`DELETE /open-request`, `open` on from-message) and §10.6/§10.7 (background action, turn detection) still describe the old design.
