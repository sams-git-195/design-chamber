# Project status — 2026-10-27

## State
- **v0.1 feature-complete on `master`**, published as a public GitHub repo (history squashed to one initial commit).
- `npm run check`: typecheck clean, build OK, **561 tests — 560 pass, 0 fail, 1 skipped** (posix-only test on Windows).
- Installed in OpenChamber from this folder, enabled, Designs folder = default `~/Documents/Designs` (empty).
  After pulling or changing code: `npm run build`, then toggle the extension off/on in Settings → Extensions
  (or restart OpenChamber).

## What's built
Rail navigator + full-screen page; HTML artifacts (ZIP + single-file HTML export to `~/Downloads`);
design canvas wall (pan/zoom both axes, screens × viewports, Edit/Play, element-anchored pins,
send comments to the linked chat, versions view/compare/restore); `/design`, `/artifact`, message
action "Open as artifact"; project-first design rules + anti-slop rules + 10 presets; headless-browser
thumbnails; theme-following UI. See `README.md`, `docs/SPEC.md`, `docs/BRIEF.md`.

## Verification done
- Live click-through in OpenChamber on Windows: `documentation/smoke/REPORT.md` (22/24 pass, the
  remaining items fixed in the fix round).
- Independent code review: `documentation/reviews/2026-10-27-code-review.md` — 2 critical + 3 major
  (data-safety), all fixed with regression tests; security boundaries held.
- Linux: full suite in Debian and Fedora 44 containers (incl. Chromium e2e). macOS: not run yet.
- `documentation/known-issues.md`: no open entries.

## Waiting on you
1. **GitHub workflow**: `master` is protected — changes go through a branch + PR; CI (Ubuntu,
   Windows, Fedora) must pass; 1 approval required, you merge via owner bypass. macOS is not in
   CI: run `npm run check` on the Mac for macOS-affecting changes.
2. **Hand tests**: `docs/testing/FEDORA.md` (dual boot) and `docs/testing/MACOS.md` (laptop) —
   install, checklist, report template. Watch for the macOS "access Documents" prompt.
3. **Claude Code agent files** (`.claude/agents/`) still pin `opus`/`sonnet`; OpenCode ones are
   unpinned. Decide whether to unpin those too.

## Housekeeping
- Docker Desktop was started for the Linux container runs and is still running.
- `package.json` exec list gained `brave`, `gio`, `gdbus` (Linux/macOS discovery/reveal) — shown
  at install approval; OpenChamber may ask to re-approve.
