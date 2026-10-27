# Rendering, versions, export and thumbnails (the service side)

What the local Node service does behind the panel and page. All of it is invisible until the
UI (WP4/WP5) surfaces it; this page describes the behaviour a user will eventually see.

## Rendering a design inside OpenChamber
Agent-written HTML cannot load its own files inside OpenChamber's sandboxed frames, so the
service **bundles** each document into one self-contained HTML string first:
- stylesheets become `<style>` blocks, following `@import` chains (max 8 deep, loops skipped);
- images, fonts, media, favicons, `srcset` candidates, `poster` and inline `style` URLs become
  `data:` URLs;
- `<script src>` files are inlined (a `</script>` inside them is escaped so it cannot break out);
- `<iframe src>` documents are bundled recursively into `data:` documents.

Anything that cannot be bundled is reported, never hidden: **missing** (file not there),
**blocked** (points outside the design folder, `<object data>`, `file:`/drive/UNC paths),
**external** (remote URLs — OpenChamber's content policy blocks them). Documents over 60 MB are
refused. Bundles are cached (256 MB LRU) and keyed by content, so a change to any input file
produces a new render; answers larger than one host message are split into ≤ 6 MB chunks that
the guest reassembles byte-exact. Each render carries a marker at the start of `<head>`; the
page swaps it for its small helper script (hover/click picking, pins, scroll, links) before
loading the document into a sandboxed frame. Exports never contain the marker. Viewing an old **version** renders the snapshot's files.

## Versions
The service snapshots the design folder (everything except `.versions/`, `.chamber/` and the
thumbnail; `design.json` without comments) as content-addressed objects:
- automatically 8 s after the files go quiet, immediately when an agent turn completes (the
  selected chat's, or a linked chat's that is not selected — seen in the project's sessions list
  while any Design Chamber frame is open),
  on "Snapshot now" (manual), and around every restore;
- snapshots of an unchanged folder are skipped (dedupe by tree hash); when an agent turn ends
  after the quiet-period auto snapshot already caught its files (within 30 minutes), that auto
  version is relabelled "After agent turn" instead of being skipped;
- the newest 100 versions are kept; unreferenced objects are garbage-collected;
- **restore** first saves the current state as a *restore-point* version, writes the old files
  back, deletes files that did not exist then, and records a *restored* version. Comments and
  the linked chat session are never touched by a restore. The version being restored is never
  pruned by its own restore point, even when the history is full. When the current files are
  too large for a snapshot (over 1 000 files or 100 MB) no restore point can be kept, so the
  restore is refused with a sentence saying so and nothing is changed.
- the version list on disk (`.versions/index.json`) is treated as untrusted: an entry naming a
  path outside the design folder (or an object that is not a content hash) makes the list
  unreadable rather than letting a restore write anywhere else.

## Export
Because a guest frame cannot download files, the service writes them itself:
- **ZIP** — the whole design folder (without `design.json`) under `<slug>/`;
- **single-file HTML** — the bundled document with every asset inlined (no bridge marker),
  for an artifact or one chosen canvas screen.
Files land in `~/Downloads` (or a configured downloads folder, falling back to
`<designs root>/.exports` when it cannot be created), named `<slug>.zip` /
`<slug>[-<screen>].html` with ` (2)`, ` (3)`… on collisions. **Show in folder** then opens the
OS file manager — but only for paths the service itself issued this run, or a design folder;
every other path is refused.

## Thumbnails
One-shot headless Chrome/Edge screenshots (no debugging protocol): 320 px wide, the design's
first viewport, network blocked and in the light colour scheme (like the wall's artboards, whatever the OS
setting) so the thumbnail matches the in-app render. The PNG is
cached at `<design>/.thumb.png` with its render key in `.chamber/thumb.json`, regenerated
2 s after content changes, killed after 20 s, one at a time. Without any installed browser the
state is `unavailable` and the UI falls back to live mini-frames.
