// Every numeric limit and identifier pattern of Design Chamber, in one place.
// Sources: docs/SPEC.md (section in brackets) and the OpenChamber host facts F1–F23 (§2).
// Service, guest and tests import these; never repeat a literal elsewhere.

// ---- Identifiers [§6.1, §6.2] ----

/** A design folder name under the root. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
/** `slugify(title)` output length before uniqueness suffixes [§9.1]. */
export const SLUG_BASE_MAX = 48;
/** Fallback slug base when a title folds to nothing [§9.1]. */
export const SLUG_FALLBACK = 'design';
/** A canvas screen id; its file is `screens/<id>.html`. */
export const SCREEN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/;
/**
 * A viewport id (`laptop`, `phone`). Not fixed by the spec; WP0 accepts the
 * same shape as a screen id plus upper case and `_`, so agent ids like
 * `Desktop_XL` survive (SPEC §14 "WP0 deviations").
 */
export const VIEWPORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/;
/** A comment id as the service mints it (`c_8f3k2`). */
export const COMMENT_ID_PATTERN = /^c_[a-z0-9]{4,24}$/;
/** A version id (`v12`). */
export const VERSION_ID_PATTERN = /^v[1-9][0-9]{0,8}$/;
/** A bundled preset id (`minimal-saas`), from `rules/presets/<id>.md`. */
export const PRESET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,59}$/;
/** An upload id as the service mints it. */
export const UPLOAD_ID_PATTERN = /^u_[A-Za-z0-9_-]{8,40}$/;
/** A lowercase hex sha256 (render keys, tree hashes, object names). */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

// ---- design.json fields [§6.2] ----

export const DESIGN_JSON_VERSION = 1;
export const STATE_JSON_VERSION = 1;
export const VERSION_INDEX_VERSION = 1;
export const SETTINGS_FILE_VERSION = 1;
export const TITLE_MIN = 1;
export const TITLE_MAX = 120;
export const BRIEF_MAX = 2000;
export const VIEWPORTS_MIN = 1;
export const VIEWPORTS_MAX = 8;
export const VIEWPORT_LABEL_MAX = 40;
export const VIEWPORT_WIDTH_MIN = 200;
export const VIEWPORT_WIDTH_MAX = 3840;
export const VIEWPORT_HEIGHT_MIN = 200;
export const VIEWPORT_HEIGHT_MAX = 4320;
export const SCREENS_MAX = 40;
export const SCREEN_DESCRIPTION_MAX = 500;
/** Characters of a session id or project directory kept in design.json. */
export const SESSION_ID_MAX = 128;
export const PROJECT_DIRECTORY_MAX = 4096;

// ---- Comments [§6.2] ----

export const COMMENT_BODY_MIN = 1;
export const COMMENT_BODY_MAX = 2000;
export const ANCHOR_TEXT_MAX = 120;
/** Opening tag snippet of the anchored element. */
export const ANCHOR_HTML_MAX = 200;
/** Not in the spec; bounds a generated selector (6 levels × classes). */
export const ANCHOR_SELECTOR_MAX = 1000;
/** Comments kept per design. Not in the spec; bounds design.json and the revision prompt input. */
export const COMMENTS_MAX = 500;
/** Text-fallback anchor match needs at least this many stored characters [§8.3]. */
export const ANCHOR_TEXT_MATCH_MIN = 12;
/** Selector generation walks at most this many ancestor levels [§8.3]. */
export const SELECTOR_DEPTH_MAX = 6;

// ---- Versions [§6.4, §4.9] ----

export const SNAPSHOT_FILES_MAX = 1000;
export const SNAPSHOT_BYTES_MAX = 100 * 1024 * 1024;
export const VERSIONS_KEEP = 100;
export const VERSION_LABEL_MAX = 120;
/** Auto snapshot after this much quiet following content changes. */
export const VERSION_QUIET_MS = 8000;
/** Turn-snapshot requests for one session within this window collapse into one [§10.6]. */
export const TURN_SNAPSHOT_DEDUPE_MS = 2000;
/** A turn snapshot that finds its files already in an `auto` version this recent relabels it as the turn's. */
export const TURN_PROMOTE_AUTO_MS = 30 * 60_000;

// ---- Settings [§6.5, §9.2] ----

export const PREVIOUS_ROOTS_MAX = 10;
export const SETTINGS_PATH_MAX = 4096;

// ---- Host transport, F7/F8 [§7] ----

/** `serviceRequest` body string, in characters (F7). */
export const HOST_REQUEST_BODY_MAX_CHARS = 64_000;
/** Whole `serviceRequest` JSON the host accepts (F7); the service caps request bodies at this. */
export const SERVICE_REQUEST_BODY_MAX_BYTES = 80_000;
/** `serviceRequest` query value, in characters (F7). */
export const HOST_QUERY_VALUE_MAX = 2000;
/** The host reads at most this many UTF-8 bytes of an answer (F8). */
export const HOST_RESPONSE_MAX_BYTES = 8_000_000;
/** The service never answers more than this (headroom under F8). */
export const SERVICE_RESPONSE_MAX_BYTES = 7_500_000;
/** The host gives up on a service request after this (F8). */
export const HOST_REQUEST_TIMEOUT_MS = 20_000;
/** Every service handler answers within this; longer work becomes a polled job [§7]. */
export const HANDLER_BUDGET_MS = 15_000;

// ---- Uploads (guest → service large text) [§7, §8.2] ----

export const UPLOAD_TOTAL_MAX = 2_000_000;
/** One `PUT /uploads/:id/:index` `data` value, measured after `JSON.stringify`. */
export const UPLOAD_CHUNK_MAX_CHARS = 60_000;
/** One upload chunk body in UTF-8 bytes, so the whole host JSON stays under F7. */
export const UPLOAD_CHUNK_MAX_BYTES = 75_000;
export const UPLOAD_TTL_MS = 10 * 60_000;
export const UPLOADS_OPEN_MAX = 8;
/** `POST /designs` inline `html` above this must go through an upload. */
export const CREATE_INLINE_HTML_MAX = 60_000;

// ---- Outbox [§7, §10.4] ----

export const OUTBOX_TTL_MS = 10 * 60_000;
/** How long "Open as artifact" waits for the rail to take its open request. */
export const OPEN_REQUEST_TTL_MS = 2 * 60_000;

// ---- Changes / watcher [§4.8, §9.4] ----

export const CHANGES_WAIT_MAX_MS = 15_000;
export const CHANGES_RING_SIZE = 500;
export const WATCH_DEBOUNCE_MS = 250;
export const WATCH_POLL_MS = 3000;
/** Guest long-poll backoff on errors [§8.2]. */
export const CHANGES_BACKOFF_MIN_MS = 1000;
export const CHANGES_BACKOFF_MAX_MS = 10_000;

// ---- Rendering [§4.1, §9.5] ----

/** `GET /render/chunk` raw text chunk, in UTF-8 bytes. */
export const RENDER_CHUNK_MAX_BYTES = 6_000_000;
/** A bundled document larger than this is refused with `too-large`. */
export const RENDER_DOC_MAX_BYTES = 60 * 1024 * 1024;
/** Service render cache (LRU). */
export const RENDER_CACHE_MAX_BYTES = 256 * 1024 * 1024;
/** Guest render-doc cache (LRU of strings) [§8.4]. */
export const GUEST_RENDER_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Parallel chunk fetches per render [§8.2]. */
export const RENDER_CHUNK_CONCURRENCY = 3;
export const BUNDLE_REFS_MAX = 500;
export const BUNDLE_CSS_DEPTH_MAX = 8;
/** `GET /designs/:slug/source` text, in characters. */
export const SOURCE_TEXT_MAX = 2_000_000;

// ---- Thumbnails [§4.4, §9.5] ----

export const THUMB_WIDTH = 320;
export const THUMB_TIMEOUT_MS = 20_000;
export const THUMB_DEBOUNCE_MS = 2000;
export const THUMB_CONCURRENCY = 1;

// ---- Guest frames and wall [§8.2, §8.4] ----

export const PAGE_LIVE_FRAMES_MAX = 12;
export const RAIL_LIVE_FRAMES_MAX = 4;
/** Artboards beyond the viewport by more than this fraction of it may unload. */
export const FRAME_UNLOAD_MARGIN = 0.5;
export const CAMERA_SCALE_MIN = 0.05;
export const CAMERA_SCALE_MAX = 4;
export const CAMERA_PAN_MAX = 1e6;
/** `scale *= exp(-deltaY * WHEEL_ZOOM_RATE)`. */
export const WHEEL_ZOOM_RATE = 0.005;
export const WALL_GAP = 96;
export const ARTBOARD_LABEL_HEIGHT = 28;

// ---- Bridge [§8.3] ----

/** `size` reports are throttled to one per this many ms. */
export const BRIDGE_SIZE_THROTTLE_MS = 100;
/** Anchors per `resolve-anchors` / `anchors` message. */
export const BRIDGE_ANCHORS_MAX = COMMENTS_MAX;
export const BRIDGE_TITLE_MAX = 200;
export const BRIDGE_URL_MAX = 2000;
export const BRIDGE_TAG_MAX = 64;
export const BRIDGE_ARTBOARD_ID_MAX = 100;
export const BRIDGE_NONCE_MAX = 64;
/** Coordinates and sizes outside ±this are rejected as malformed. */
export const BRIDGE_COORD_MAX = 1e7;

// ---- Chat / agent instructions [§10, §11], host caps F13/F15 ----

/** Host cap on chip text, prompt and compose text. */
export const HOST_TEXT_MAX = 16_000;
/** Host cap on `JSON.stringify(chip.data)`. */
export const HOST_ATTACH_DATA_MAX = 16_000;
export const HOST_ATTACH_ID_MAX = 128;
export const HOST_ATTACH_TITLE_MAX = 200;
export const HOST_ATTACH_URL_MAX = 2000;
/** `writeClipboard` text cap; Copy HTML is offered only up to this. */
export const HOST_CLIPBOARD_MAX = 32_000;
/** Host cap on a toast message. */
export const HOST_TOAST_MAX = 500;
/** `GuestMessageItem.text` cap (F17). */
export const HOST_MESSAGE_TEXT_MAX = 200_000;
/** Chip core text target and hard cap asserted in tests [§11]. */
export const CHIP_TEXT_TARGET = 5000;
export const CHIP_TEXT_HARD_MAX = 15_000;
/** Revision prompt cap [§11.4]. */
export const REVISION_TEXT_MAX = HOST_TEXT_MAX;
/** Project sources listed in the chip core [§11.3]. */
export const CHIP_PROJECT_PATHS_MAX = 6;
/** Chip build budget, discovery included [§10.1]. */
export const CHIP_BUILD_BUDGET_MS = 3000;

// ---- Project-rules discovery [§11.1] ----

export const DISCOVERY_DEPTH_MAX = 4;
export const DISCOVERY_ENTRIES_MAX = 3000;
export const DISCOVERY_TIME_MAX_MS = 1500;
export const DISCOVERY_SOURCES_MAX = 20;
/** CSS `@media` widths turned into viewport suggestions. */
export const DISCOVERY_BREAKPOINTS_MAX = 4;
/** Custom properties in one `:root{}` block that make a CSS file a token source. */
export const DISCOVERY_ROOT_VARS_MIN = 5;
