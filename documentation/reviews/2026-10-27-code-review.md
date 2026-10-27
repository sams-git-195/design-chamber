# Code Review: whole codebase `0a83ed7..HEAD` (src, scripts, package.json) — 2026-10-27

**Verdict:** `BLOCKED` (2 Critical)
**Counts:** Critical (🔴) 2 · Major (🟠) 3 · Minor 6 (🟣 2 logged + 🟡 4 nits) · 🔵 FYI 4

**Reviewed:** all 92 files in the range, read in full for the service (`src/service/**`), the
shared contract (`src/shared/{bridge-protocol,design-json,limits}.ts`), the guest core
(`src/guest/{frame-doc,frame-channel,changes,store,service-client,flows}.ts`, `bridge/bridge.ts`)
and the UI files that touch frames, blobs and links (`ui/wall/{frame-slot,wall,design-view}.ts`,
`ui/components/{thumb,kit,dom}.ts`), `scripts/build.mjs`. Around it: the OpenChamber SDK
host source check (`packages/sdk/src/host.ts:302`, `DOCUMENTATION.md:91`), the test harnesses
(`test/helpers/*`, `test/service/render/harness.ts`), `docs/SPEC.md` §6.1.

**Gates** (run 2026-10-27; `npm run build` deliberately NOT run — a concurrent smoke test owns `dist/`):
- `npm run typecheck` → `tsc --noEmit`, no output (pass; includes the new `test/review/*.ts`).
- `npm test` → `ℹ tests 502 · ℹ pass 502 · ℹ fail 0` (pass, 55 s).

**Mutation check** (every mutation restored; `git diff | sha1sum` = `ce10989e…` before and after):

| Value changed | File:line | Test run | Result |
|---|---|---|---|
| realpath escape check disabled (`if (false && isEscaping(…))`) | `src/service/paths.ts:124` | `test/service/core/paths.test.ts` | 🔴 red (4 fail) — guarded |
| ring floor `oldest.seq - 1` → `- 2` | `src/service/changes.ts:31` | `test/service/core/changes.test.ts` | 🔴 red (1 fail) — guarded |
| chunk order `index !== chunks.length` → `index > chunks.length` | `src/service/uploads.ts:69` | `uploads-outbox`, `routes`, `chat-routes`, `service-client` tests | 🟢 **green (64 pass)** → finding M3 |

**Proof tests** live in `test/review/*.review.ts` — deliberately outside the `npm test` glob
(`test/**/*.test.ts`) so the gate stays green. Run one with `node --test test/review/<file>`.
Each failing one turns green when its finding is fixed; then rename it to `*.test.ts` and move it
next to its suite.

---

## Critical

| # | File:line | Finding | Why it matters (failure scenario) | Proof | Owner |
|---|---|---|---|---|---|
| C1 | `src/service/versions.ts:407-416`, `:381-383` | **Restoring the oldest version when history is full destroys it and half-restores the design.** `restoreNow` looks up the target entry, then takes the `restore-point` snapshot, which pushes a 101st entry, prunes the oldest (= the target) and garbage-collects its unique objects; the restore loop then `readFile`s a deleted object. | User has used a design for a few days (auto + turn snapshots reach `VERSIONS_KEEP` = 100), has unsaved edits, opens Versions and restores the very first version → 500 "unexpected problem", some files already overwritten, the others not; the version they wanted is gone from the list and from disk. | `node --test test/review/versions-restore.review.ts` → `C1 … ✖ ENOENT … .versions\objects\60\6042…` | fullstack-developer |
| C2 | `src/service/versions.ts:341-344`, `:410-412`, `:428-432` | **Restore deletes files that no snapshot holds.** When the current tree is over `SNAPSHOT_FILES_MAX` (1000) or `SNAPSHOT_BYTES_MAX` (100 MB), `snapshotNow` logs `snapshot-skipped` and returns `null`; `restoreNow` treats that as "restore point taken" and goes on to overwrite and `rm` every tracked file the target lacks. | The agent adds a big asset set (or a >100 MB video) after v3; user restores v3 → those assets are deleted permanently with no restore point. | same file → `C2 … ✖ restore deleted 1001 files that no version holds, with no restore point` | fullstack-developer |

## Major

| # | File:line | Finding | Why it matters (failure scenario) | Proof | Owner |
|---|---|---|---|---|---|
| M1 | `src/service/store.ts:211-237` (callers `:400-487`) | **Two-writer race on design.json loses the agent's edits.** Every service mutation reads design.json in `readInternal`, awaits (stat of each screen, state.json write), then renames its merge of the *old* agent fields over the file. The per-slug lock only serialises the service; an agent write in the window is silently replaced, and the following `reconcile` sees no service-field drift, so nothing restores it. | User adds or resolves a comment while the agent is writing design.json (adding a screen, a viewport, `designSystem.confirmed`) → the agent's change vanishes; the new screen never appears on the wall and the agent believes it wrote it. Classified Major, not Critical: the screen HTML files survive and the agent can re-write the metadata. | `node --test test/review/design-json-race.review.ts` → `✖ 59 of 59 agent writes to design.json were silently overwritten by a concurrent comment` | fullstack-developer |
| M2 | `src/service/store.ts:285-306`, `src/service/versions.ts:471-483`, `src/service/watch.ts:122-126` | **Any lowercase folder under the root is treated as a design and written into.** SPEC §6.1 recognises a folder with `design.json` (or `index.html`); the code treats every slug-named directory as one: `reconcile` writes `.chamber/state.json` into it and the auto snapshot copies all its files (≤ 1000 / 100 MB) into a new `.versions/`. It is also listed and offered for Delete. | The user points the designs folder at an existing folder (e.g. `C:\Users\me\Documents`, allowed by `validateRootCandidate`) → every time they edit a file in `Documents\notes\…`, Design Chamber writes hidden `.chamber` and `.versions` (with full copies of their files) into it, and "notes" shows up as an empty canvas they can trash. | `node --test test/review/foreign-folders.review.ts` → `✖ actual: ['.chamber', '.versions', 'journal', 'todo.txt']` | fullstack-developer |
| M3 | `test/service/core/uploads-outbox.test.ts` (covers `src/service/uploads.ts:69`) | **Tests cannot detect a broken chunk-order check.** Loosening `index !== entry.chunks.length` to `index > …` (accepting a replayed earlier chunk) keeps all 64 upload-related tests green. | That regression would let a retried chunk 0 be appended twice, so "Open as artifact" or a big initial HTML is silently assembled with duplicated content. | mutation table above | qa-tester (test) |

## Minor

| # | Light | File:line | Finding | Why / fix | Owner |
|---|---|---|---|---|---|
| m1 | 🟣 KI-1 | `src/service/watch.ts:48-49`, `src/guest/store.ts:76-90` | Poll-only roots: the design-folder mtime in the fingerprint turns the service's own dot writes (`.thumb.png` publish, `.design.json.tmp-*`) into `files: ['.']`, which `affectedSources` maps to "reload every artboard". | Logged with fix prompt. Proof: `node --test test/review/watch-dot-writes.review.ts` → `actual: ['.']`. With fs.watch working the same write is absorbed (verified), so only network/OneDrive roots are hit. | fullstack-developer |
| m2 | 🟣 KI-2 | `src/guest/flows.ts:311-314`, `:338-339` | `sendComments` prompts first, then `markSent`; if mark-sent fails the flow rejects although the revision was delivered, the comments stay `open`, and the next "Send comments" sends them again. | Logged with fix prompt. | fullstack-developer |
| m3 | 🟡 | `src/service/routes/render.ts:48-49` | `GET /source` reads `path.join(record.path, entryRel)` without `resolveInside`; a `screens` junction inside a design is followed out of the root. Render (bundle.ts) refuses the same path, so the two routes disagree with SPEC §9.1. | Resolve through `resolveInside(record.path, entryRel.split('/'))` and map `bad-path` to `no-html`. | fullstack-developer |
| m4 | 🟡 | `src/guest/fake-services.ts` (828 lines) | Test/dev-only fake shipped under `src/`; no production import (checked), only tests. | Move to `test/helpers/` (or `src/dev/`) so the production tree is production code. | fullstack-developer |
| m5 | 🟡 | `src/service/store.ts:361` | The global create lock uses key `'create'` in the same map as per-slug locks, so a design slugged `create` serialises with every create. Harmless today. | Use a key no slug can be, e.g. `'\0create'`. | fullstack-developer |
| m6 | 🟡 | `src/service/routes/designs.ts:46`, `:99-101` | `POST /designs` and `PATCH /designs/:slug` accept any `projectDirectory` text (relative paths too); `routes/chat.ts:48-54` refuses non-absolute ones. No guest flow sends it today. | Reuse `projectDirectoryOf` from chat.ts (move it to a shared validator). | fullstack-developer |

## Fix prompt — required (Critical + Major)

    You are fixing review findings in Design Chamber. Read AGENTS.md and your agent file first.
    Findings to fix (do all, nothing else):
    1. [C1] src/service/versions.ts restoreNow (:395-445) — the restore-point snapshot prunes and
       GCs the version being restored when the index holds VERSIONS_KEEP entries. Correct: the
       target can never be pruned or collected during its own restore — e.g. read every target
       object into memory (bounded by SNAPSHOT_BYTES_MAX) before taking the restore point, or let
       snapshotNow take a `keep` id that pruning skips and GC treats as referenced. A restore must
       either complete or write nothing.
    2. [C2] src/service/versions.ts restoreNow (:407-432) — when the current tree is over
       SNAPSHOT_FILES_MAX/SNAPSHOT_BYTES_MAX the restore point is skipped (snapshotNow → null) but
       the restore still overwrites and deletes files. Correct: if the tree differs from the latest
       version and no restore point could be stored, refuse with ApiError('invalid', a sentence
       that says the design is too large to keep a restore point and what to do) and touch nothing.
    3. [M1] src/service/store.ts writeStateAndMirror (:211-237) — an agent write between
       readInternal and the rename is overwritten. Correct: immediately before writing the mirror,
       re-read design.json; if its text differs from read.designText, re-parse and re-merge from the
       fresh text (bounded retries, e.g. 3; if it is unparseable leave it alone as today). Apply the
       same to the reconcile path. The window must shrink to the rename itself.
    4. [M2] src/service/store.ts list/readInternal/reconcile, src/service/versions.ts auto
       snapshots, src/service/thumbnails.ts — only folders that are designs per SPEC §6.1
       (design.json, .chamber/state.json, index.html or a screens/ folder) are listed, reconciled,
       snapshotted or captured; everything else under the root is never written into. Keep the
       "agent writes the HTML first" case working (index.html alone still lists as an artifact).
    5. [M3] test/service/core/uploads-outbox.test.ts — add a test that re-sends an already stored
       chunk index (and a skipped-ahead one) and expects 409 conflict with the received count
       unchanged; prove it by changing src/service/uploads.ts:69 to `index > entry.chunks.length`,
       seeing red, restoring.
    For each: reproduce or locate it, fix the root cause, add or extend a test that fails
    without the fix (prove it: revert the fix line, see red, restore). The proofs already exist:
    test/review/versions-restore.review.ts (C1, C2), test/review/design-json-race.review.ts (M1),
    test/review/foreign-folders.review.ts (M2) — make them pass, then move each into its suite as
    *.test.ts and delete the review copy.
    Do not refactor beyond these findings. Run: npm run typecheck · npm run build · npm test.
    Paste real output. End with your handoff line.

## Fix prompt — optional (🟡 nits)

    You are fixing review nits in Design Chamber. Read AGENTS.md and your agent file first.
    1. [m3] src/service/routes/render.ts:48 — read the /source file through
       resolveInside(record.path, entryRel.split('/')); bad-path → 'no-html'. Test: a screens
       junction (fs.symlink(dir, …, 'junction')) pointing outside the design answers no-html.
    2. [m4] move src/guest/fake-services.ts to test/helpers/ and update its 4 test importers
       and the SPEC/GUEST-API mentions.
    3. [m5] src/service/store.ts:361 — lock key '\0create'.
    4. [m6] validate projectDirectory as absolute (and NUL-free) in routes/designs.ts create and
       patch, reusing chat.ts's projectDirectoryOf.
    Run npm run typecheck · npm run build · npm test; paste output.

## Logged to known-issues.md (🟣)

- **KI-1** poll-only roots reload every artboard after the service's own writes (m1) — fix prompt in the entry.
- **KI-2** a delivered revision whose mark-sent fails is sent again (m2) — fix prompt in the entry.

## Security boundaries — checked and holding

- **Sandbox:** every design frame is `sandbox="allow-scripts"` only (`frame-doc.ts:12`, `frame-slot.ts:43`); live thumbnails `sandbox=""`; `allow-same-origin` appears nowhere in `src/`. No `innerHTML`/`insertAdjacentHTML`/`srcdoc` anywhere (`dom.ts` builds with `textContent`/`setAttribute`).
- **Host reach:** the OpenChamber host accepts guest messages only from `event.source === contentWindow` (`openchamber/packages/sdk/src/host.ts:302`), so a nested design frame's `top.postMessage` is ignored; the guest never holds the bearer token.
- **Bridge:** page side checks source window + shape + artboardId + nonce (`frame-channel.ts:22-31`); frame side checks `event.source === parent` (`bridge.ts:162`); every field is length/range-checked (`bridge-protocol.ts:148-158`); `open-external` is `https?:` only and user-confirmed (`design-view.ts:113-121`); `navigate` only switches to a listed screen file.
- **Injection:** bridge injected with `<`-free JSON (`frame-doc.ts:35`) and a build-time `</script` assert (`build.mjs:31`); inlined scripts escape `</script` (`bundle.ts:268`); attribute rewrites are quote-escaped; file:, drive, UNC and escaping refs are blocked; the live source reads only through `resolveInside`.
- **Service:** bearer on every route incl. /health and 404s, SHA-256 + `timingSafeEqual`, empty token never matches (`http.ts:45-46,152`); binds `127.0.0.1` only (`http.ts:296`); 80 kB body cap, 7.5 MB answer cap; no CORS headers (host proxy only); params with `/ \ NUL` refused.
- **Containment:** `resolveInside` refuses absolute/drive/UNC/`..` lexically, then compares realpaths case-insensitively on win32 (mutation-checked above); slugs are `^[a-z0-9][a-z0-9-]{0,62}$` and never a device name; `.versions/index.json` entries are re-validated (safe rel, tracked, sha256) and restore writes go through `resolveInside`.
- **Spawning:** reveal accepts only paths issued by this run's exports or listed design folders, spawned with an args array, no shell (`reveal.ts:80-105`); thumbnails spawn with an args array. Thumbnail network block verified: `test/review/thumbnail-network.review.ts` passes with the shipped flags and fails without them (control run during the review).
- **ZIP:** entry names are `<slug>/<readdir name>` — no `..` can arise on Windows; symlinks/junctions are skipped by `listTracked`.
- **Root change / delete:** a drive root and the extension folder are refused; delete only renames into `<root>/.trash`, never hard-deletes (see M2 for what a broad root does).
- **Change feed / outbox / uploads:** epoch reset and ring floor are right and guarded by tests; outbox `DELETE` takes the slot once; uploads are bounded (8 × 2 M chars, 10 min TTL, lazy sweep).

## Unverified concerns

- Two concurrent `PUT /settings` can lose one of the changes (`settings.ts:137` copies `current` before awaiting the root probe). Only one settings view sends it; no scenario found.
- On a thumbnail timeout `child.kill()` ends only Chrome's main process; Windows usually reaps the children, but a locked profile can make the `rm(work)` fail silently and leave a `dc-thumb-*` folder in %TEMP%. Not reproduced.

## FYI (🔵)

- Everything a design sends over the bridge stays advisory by design: its scripts share the bridge's realm and can read `window.__DC.nonce`. A hostile design can therefore fake pin rects or repeat `open-external` prompts (each needs a click). Fine as long as no privileged message type is ever added to `FRAME_TO_PAGE`.
- `PUT /settings` `chromePath` names any executable the thumbnail queue later spawns. Only our own settings UI can set it, so a guest-side XSS would become code execution. Today there is no XSS sink (no `innerHTML`). Keep it that way.
- Anchor `text`/`html` captured from the design DOM go verbatim into the revision prompt. A design can thus put text in front of the agent. That is the same agent that wrote it, so no new trust boundary.
- `.git` or `.env` files the agent leaves inside a design folder are versioned and exported (only `.versions`, `.chamber`, `.thumb*` are excluded).

## Triaged out

- `deliverOutbox` takes the slot before prompting, so a failed prompt drops the text. The comments stay open and an error toast says so, which handles it gracefully.
- A backslash inside a POSIX file name becomes a ZIP entry that Windows extractors split. Unreachable on the Windows host, where names cannot contain `\`.
- Concurrent exports of the same name can pick the same target. Both writes carry the same content and no user file is overwritten (`existsSync` guards the pre-existing ones).
- Placeholder text `<!--dc-bridge-->` authored inside a design breaks only that design's own frame, not the user's.

Review BLOCKED → main agent (2 🔴, 3 🟠 — fix prompt attached)

---

## Resolution (2026-10-27, branch `review-fixes`, fullstack-developer)

Every Critical and Major finding is fixed. Each proof test moved into the regular suite and was mutation-checked: revert the fix → red, restore → green.

| # | Fix | Guard (now in `npm test`) | Mutation → result |
|---|---|---|---|
| C1 | `snapshotNow` takes `keep`: pruning skips the version being restored, so GC keeps its objects (`versions.ts` restore point `{ keep: target.id, required: true }`). | `test/service/render/versions-restore.test.ts` C1 (also restores the restore point back) | drop `keep` → ✖ C1 |
| C2 | `required: true`: an over-cap tree throws `invalid` ("This design is too large to keep a restore point … Nothing was changed …") before any write. | same file, C2 (asserts the refusal, all 1 001 assets and the edited page intact, no new version) | drop `required` → ✖ C2 |
| M1 | New `replaceFileIfUnchanged` (`paths.ts`): tmp write, then a synchronous compare + rename only if design.json still holds the merged-from text. Otherwise the store re-reads, re-parses and re-merges (5 attempts, growing 25 ms pauses; then it leaves the agent's file to reconcile and logs `store.design-json-busy`). A Windows `EPERM`/`EBUSY`/`EACCES` on the rename counts as "not yet" and is retried too. Without that retry, `watch.test.ts` "merge never loops" hung about 1 run in 3. Covers every service mutation and reconcile. | `test/service/core/design-json-race.test.ts` (60 rounds, plus every accepted comment is still in state.json) | unconditional `writeFileAtomic` → ✖ "59 of 59 agent writes … overwritten" |
| M2 | `isDesignFolder` (`root.ts`): design.json, `.chamber/state.json`, `index.html` or `screens/`. Gated in `store.designDir` (so get/reconcile/versions/thumbnails/trash/comments answer `not-found`), `store.list` and `countDesigns`. The root also refuses the home folder, any folder above it and `Documents` itself ("That folder holds your own files …"). | `test/service/core/foreign-folders.test.ts` (no writes, not listed, not trashable; index.html-only and screens-only folders still list), `settings.test.ts` (home/above/Documents refused, `Documents\Designs` accepted; countDesigns), `core/routes.test.ts` (PUT /settings home + Documents → 400) | drop the `designDir` gate → ✖ M2; drop the home/Documents check → ✖ settings |
| M3 | Test only: replayed chunk 0, a repeated last chunk and a skipped-ahead chunk each give 409 and leave the upload intact. | `test/service/core/uploads-outbox.test.ts` | `index > chunks.length` → ✖ |

Minor items:
- **m1 / KI-1 fixed.** The poll fingerprint no longer uses the design folder's own mtime. It records the names of the non-dot top-level entries instead, so a new top-level file is still reported by name and the service's dot writes are silent. Guard: `watch.test.ts` "poll-only roots … (KI-1)", red without the fix. The entry is gone from `known-issues.md`.
- **m3 fixed.** `GET /source` reads through `resolveInside`; an escaping path answers `no-html`. Guard: `render/routes.test.ts` "source never follows a screens junction", red without the fix.
- **m5 fixed.** The create lock key is now `'\0create'`.
- **m6 fixed.** `POST /designs` and `PATCH /designs/:slug` validate `projectDirectory` with chat.ts's `projectDirectoryOf`, now exported: absolute and NUL-free, else 400 `bad-path`. Guard: `core/routes.test.ts`.
- **m2 / KI-2 still open** (guest flow plus a drawer notice in the UI lane). It stays in `known-issues.md`.
- **m4 still open.** Moving `src/guest/fake-services.ts` to `test/helpers/` touches SPEC/GUEST-API docs, and nothing reaches users.
- `test/review/thumbnail-network.review.ts` moved to `test/service/render/thumbnail-network.test.ts`. It skips when no Chrome or Edge is installed. `test/review/` is now empty.

Gates: `npm run check` → typecheck clean · build ok · `ℹ tests 513 · ℹ pass 513 · ℹ fail 0 · ℹ skipped 0`.
