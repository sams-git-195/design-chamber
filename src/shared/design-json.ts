// The design.json contract (docs/SPEC.md §6.2–§6.4): pure parse, normalise and merge.
//
// design.json is written by the user's chat agent, so it is untrusted input. Reading is
// tolerant: invalid agent fields are dropped with a `DesignWarning`, never fatal; unknown
// top-level keys are preserved (`extra`). Writing never re-serialises the normalised view —
// `mergeServiceFields` patches only the service-owned keys into the agent's raw object, so
// whatever the agent wrote (even fields this version cannot read) survives a service write.

import {
  ANCHOR_HTML_MAX,
  ANCHOR_SELECTOR_MAX,
  ANCHOR_TEXT_MAX,
  BRIDGE_COORD_MAX,
  BRIEF_MAX,
  COMMENT_BODY_MAX,
  COMMENT_ID_PATTERN,
  COMMENTS_MAX,
  DESIGN_JSON_VERSION,
  PRESET_ID_PATTERN,
  PROJECT_DIRECTORY_MAX,
  SCREEN_DESCRIPTION_MAX,
  SCREEN_ID_PATTERN,
  SCREENS_MAX,
  SESSION_ID_MAX,
  STATE_JSON_VERSION,
  TITLE_MAX,
  VIEWPORT_HEIGHT_MAX,
  VIEWPORT_HEIGHT_MIN,
  VIEWPORT_ID_PATTERN,
  VIEWPORT_LABEL_MAX,
  VIEWPORT_WIDTH_MAX,
  VIEWPORT_WIDTH_MIN,
  VIEWPORTS_MAX,
} from './limits.ts';
import type {
  AgentOwnedField,
  Comment,
  CommentAnchor,
  CommentStatus,
  DesignJson,
  DesignKind,
  DesignSystemStatus,
  DesignWarning,
  IsoDate,
  JsonObject,
  JsonValue,
  Rect,
  RelPoint,
  Screen,
  ServiceOwnedField,
  ServiceState,
  Viewport,
} from './types.ts';

export const DESIGN_SCHEMA = 'design-chamber/design@1';
/** The artifact entry file; the agent may not change it. */
export const ENTRY_FILE = 'index.html';
export const DESIGN_JSON_FILE = 'design.json';

export const VIEWPORT_LAPTOP: Readonly<Viewport> = Object.freeze({ id: 'laptop', label: 'Laptop', width: 1280, height: 800 });
export const VIEWPORT_PHONE: Readonly<Viewport> = Object.freeze({ id: 'phone', label: 'Phone', width: 390, height: 844 });

/** Canvas: Laptop + Phone. Artifact: Laptop (BRIEF defaults, SPEC §6.2). Fresh copies. */
export const defaultViewports = (kind: DesignKind): Viewport[] =>
  kind === 'canvas' ? [{ ...VIEWPORT_LAPTOP }, { ...VIEWPORT_PHONE }] : [{ ...VIEWPORT_LAPTOP }];

export const SERVICE_OWNED_FIELDS: readonly ServiceOwnedField[] = [
  'version', 'kind', 'created', 'brief', 'sessionId', 'projectDirectory', 'preset', 'entry', 'comments',
];
export const AGENT_OWNED_FIELDS: readonly AgentOwnedField[] = ['title', 'updated', 'viewports', 'screens', 'designSystem'];

/** Canonical key order for files the service creates. */
const CANONICAL_ORDER: readonly (keyof DesignJson)[] = [
  'version', 'kind', 'title', 'created', 'updated', 'brief', 'sessionId', 'projectDirectory', 'preset', 'entry',
  'viewports', 'screens', 'designSystem', 'comments',
];
const KNOWN_FIELDS: ReadonlySet<string> = new Set<string>(CANONICAL_ORDER);
const COMMENT_STATUSES: readonly CommentStatus[] = ['open', 'sent', 'resolved'];

/** The canvas screen file for a screen id. */
export const screenFileOf = (screenId: string): string => `screens/${screenId}.html`;

// ---- small guards ----

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
const has = (record: Rec, key: string): boolean => Object.hasOwn(record, key);
const isFiniteNum = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= BRIDGE_COORD_MAX;
const isIntIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const isKind = (value: unknown): value is DesignKind => value === 'artifact' || value === 'canvas';

/** An ISO-8601-looking timestamp that `Date.parse` accepts. */
export const isIsoDate = (value: unknown): value is IsoDate =>
  typeof value === 'string' && value.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(value) && !Number.isNaN(Date.parse(value));

const nonEmpty = (value: unknown, max: number): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= max ? trimmed : null;
};

class Warnings {
  readonly list: DesignWarning[] = [];
  add(code: string, field: string | undefined, message: string): void {
    this.list.push(field === undefined ? { code, message } : { code, field, message });
  }
}

// ---- element parsers (exported: routes validate request bodies with them) ----

const parseRect = (value: unknown): Rect | null =>
  isRec(value) && isFiniteNum(value.x) && isFiniteNum(value.y) && isFiniteNum(value.w) && isFiniteNum(value.h) && value.w >= 0 && value.h >= 0
    ? { x: value.x, y: value.y, w: value.w, h: value.h }
    : null;

const parseRelPoint = (value: unknown): RelPoint | null =>
  isRec(value) && isFiniteNum(value.x) && isFiniteNum(value.y) && value.x >= 0 && value.x <= 1 && value.y >= 0 && value.y <= 1
    ? { x: value.x, y: value.y }
    : null;

export const parseCommentAnchor = (value: unknown): CommentAnchor | null => {
  if (!isRec(value)) return null;
  const { selector, text, html } = value;
  if (typeof selector !== 'string' || selector.length < 1 || selector.length > ANCHOR_SELECTOR_MAX) return null;
  if (typeof text !== 'string' || text.length > ANCHOR_TEXT_MAX) return null;
  if (typeof html !== 'string' || html.length > ANCHOR_HTML_MAX) return null;
  const rect = parseRect(value.rect);
  const point = parseRelPoint(value.point);
  if (!rect || !point) return null;
  return { selector, text, html, rect, point };
};

export const parseComment = (value: unknown): Comment | null => {
  if (!isRec(value)) return null;
  const { id, screen, viewport, body, status, created } = value;
  if (typeof id !== 'string' || !COMMENT_ID_PATTERN.test(id)) return null;
  if (screen !== null && (typeof screen !== 'string' || !SCREEN_ID_PATTERN.test(screen))) return null;
  if (typeof viewport !== 'string' || !VIEWPORT_ID_PATTERN.test(viewport)) return null;
  if (typeof body !== 'string' || body.trim().length < 1 || body.length > COMMENT_BODY_MAX) return null;
  if (!COMMENT_STATUSES.includes(status as CommentStatus)) return null;
  if (!isIsoDate(created)) return null;
  const anchor = parseCommentAnchor(value.anchor);
  if (!anchor) return null;
  const sentAt = value.sentAt === undefined || value.sentAt === null ? null : isIsoDate(value.sentAt) ? value.sentAt : undefined;
  const sentVersion =
    value.sentVersion === undefined || value.sentVersion === null ? null : isIntIn(value.sentVersion, 1, Number.MAX_SAFE_INTEGER) ? value.sentVersion : undefined;
  if (sentAt === undefined || sentVersion === undefined) return null;
  return { id, screen, viewport, anchor, body, status: status as CommentStatus, created, sentAt, sentVersion };
};

const parseViewport = (value: unknown, index: number, warnings: Warnings): Viewport | null => {
  const field = `viewports[${index}]`;
  if (!isRec(value) || typeof value.id !== 'string' || !VIEWPORT_ID_PATTERN.test(value.id)) {
    warnings.add('invalid-viewport', field, `Viewport ${index + 1} has no valid id (letters, digits, - or _), so it is not shown.`);
    return null;
  }
  const { id } = value;
  if (!isIntIn(value.width, VIEWPORT_WIDTH_MIN, VIEWPORT_WIDTH_MAX) || !isIntIn(value.height, VIEWPORT_HEIGHT_MIN, VIEWPORT_HEIGHT_MAX)) {
    warnings.add(
      'invalid-viewport',
      field,
      `Viewport "${id}" needs a whole-number width ${VIEWPORT_WIDTH_MIN}–${VIEWPORT_WIDTH_MAX} and height ${VIEWPORT_HEIGHT_MIN}–${VIEWPORT_HEIGHT_MAX}, so it is not shown.`,
    );
    return null;
  }
  let label = nonEmpty(value.label, VIEWPORT_LABEL_MAX);
  if (label === null) {
    if (has(value, 'label')) warnings.add('invalid-viewport-label', `${field}.label`, `Viewport "${id}" has an unusable label; its id is shown instead.`);
    label = id;
  }
  return { id, label, width: value.width, height: value.height };
};

const normalizeFilePath = (value: string): string => value.replace(/\\/g, '/').replace(/^(\.\/)+/, '');

const parseScreen = (value: unknown, index: number, viewportIds: ReadonlySet<string>, warnings: Warnings): Screen | null => {
  const field = `screens[${index}]`;
  if (!isRec(value) || typeof value.id !== 'string' || !SCREEN_ID_PATTERN.test(value.id)) {
    warnings.add('invalid-screen', field, `Screen ${index + 1} has no valid id (lower-case letters, digits and -), so it is not shown.`);
    return null;
  }
  const { id } = value;
  const file = screenFileOf(id);
  if (has(value, 'file') && (typeof value.file !== 'string' || normalizeFilePath(value.file) !== file)) {
    warnings.add('invalid-screen-file', `${field}.file`, `Screen "${id}" must live in ${file}, so it is not shown.`);
    return null;
  }
  let title = nonEmpty(value.title, TITLE_MAX);
  if (title === null) {
    if (has(value, 'title')) warnings.add('invalid-screen-title', `${field}.title`, `Screen "${id}" has an unusable title; its id is shown instead.`);
    title = id;
  }
  const screen: Screen = { id, title, file };
  if (has(value, 'viewports')) {
    if (!Array.isArray(value.viewports)) {
      warnings.add('invalid-screen-viewports', `${field}.viewports`, `Screen "${id}" lists its viewports wrongly, so it shows at every viewport.`);
    } else {
      const known = value.viewports.filter((v): v is string => typeof v === 'string' && viewportIds.has(v));
      const unique = [...new Set(known)];
      if (unique.length !== value.viewports.length) {
        warnings.add('unknown-screen-viewport', `${field}.viewports`, `Screen "${id}" names viewports this design does not have; those are skipped.`);
      }
      if (unique.length > 0) screen.viewports = unique;
    }
  }
  if (has(value, 'description')) {
    if (typeof value.description === 'string' && value.description.length <= SCREEN_DESCRIPTION_MAX) {
      screen.description = value.description;
    } else {
      warnings.add('invalid-screen-description', `${field}.description`, `Screen "${id}" has a description over ${SCREEN_DESCRIPTION_MAX} characters; it is not shown.`);
    }
  }
  return screen;
};

const parseViewports = (raw: Rec, kind: DesignKind, warnings: Warnings): Viewport[] => {
  if (!has(raw, 'viewports')) return defaultViewports(kind);
  if (!Array.isArray(raw.viewports)) {
    warnings.add('invalid-viewports', 'viewports', 'The viewport list is not a list, so the default viewports are used.');
    return defaultViewports(kind);
  }
  const result: Viewport[] = [];
  const seen = new Set<string>();
  raw.viewports.forEach((entry, index) => {
    const viewport = parseViewport(entry, index, warnings);
    if (!viewport) return;
    if (seen.has(viewport.id)) {
      warnings.add('duplicate-viewport', `viewports[${index}]`, `Viewport "${viewport.id}" is listed twice; only the first is shown.`);
      return;
    }
    seen.add(viewport.id);
    result.push(viewport);
  });
  if (result.length > VIEWPORTS_MAX) {
    warnings.add('too-many-viewports', 'viewports', `Only the first ${VIEWPORTS_MAX} viewports are shown.`);
    result.length = VIEWPORTS_MAX;
  }
  if (result.length === 0) {
    warnings.add('no-valid-viewports', 'viewports', 'No usable viewport is listed, so the default viewports are used.');
    return defaultViewports(kind);
  }
  return result;
};

const parseScreens = (raw: Rec, kind: DesignKind, viewports: Viewport[], warnings: Warnings): Screen[] => {
  if (!has(raw, 'screens')) return [];
  if (kind === 'artifact') {
    if (Array.isArray(raw.screens) && raw.screens.length > 0) {
      warnings.add('screens-ignored', 'screens', 'This design is an artifact, so its screen list is ignored (it shows index.html).');
    }
    return [];
  }
  if (!Array.isArray(raw.screens)) {
    warnings.add('invalid-screens', 'screens', 'The screen list is not a list, so no screens are shown.');
    return [];
  }
  const viewportIds = new Set(viewports.map((v) => v.id));
  const result: Screen[] = [];
  const seen = new Set<string>();
  raw.screens.forEach((entry, index) => {
    const screen = parseScreen(entry, index, viewportIds, warnings);
    if (!screen) return;
    if (seen.has(screen.id)) {
      warnings.add('duplicate-screen', `screens[${index}]`, `Screen "${screen.id}" is listed twice; only the first is shown.`);
      return;
    }
    seen.add(screen.id);
    result.push(screen);
  });
  if (result.length > SCREENS_MAX) {
    warnings.add('too-many-screens', 'screens', `Only the first ${SCREENS_MAX} screens are shown.`);
    result.length = SCREENS_MAX;
  }
  return result;
};

const parseComments = (raw: Rec, warnings: Warnings): Comment[] => {
  if (!has(raw, 'comments')) return [];
  if (!Array.isArray(raw.comments)) {
    warnings.add('invalid-comments', 'comments', 'The comment list is not a list, so no comments are shown.');
    return [];
  }
  const result: Comment[] = [];
  const seen = new Set<string>();
  raw.comments.forEach((entry, index) => {
    const comment = parseComment(entry);
    if (!comment || seen.has(comment.id)) {
      warnings.add('invalid-comment', `comments[${index}]`, `Comment ${index + 1} is damaged or repeated, so it is not shown.`);
      return;
    }
    seen.add(comment.id);
    result.push(comment);
  });
  if (result.length > COMMENTS_MAX) {
    warnings.add('too-many-comments', 'comments', `Only the first ${COMMENTS_MAX} comments are shown.`);
    result.length = COMMENTS_MAX;
  }
  return result;
};

const optionalString = (raw: Rec, key: string, max: number, warnings: Warnings, label: string): string | null => {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && value.length >= 1 && value.length <= max) return value;
  warnings.add(`invalid-${key}`, key, `The ${label} in design.json is not usable and is ignored.`);
  return null;
};

// ---- normalise ----

export type NormalizeOptions = {
  /** Authoritative kind (from `.chamber/state.json`, or the service's file-based guess). Without it, design.json's kind is used, else inferred. */
  kind?: DesignKind;
  /** Title when design.json has none (the service passes the slug). */
  fallbackTitle: string;
  /** Timestamp when `created`/`updated` are missing (the service passes the folder mtime). */
  fallbackTime: IsoDate;
};

export type NormalizedDesign = {
  design: DesignJson;
  /** Unknown top-level keys, verbatim. */
  extra: JsonObject;
  warnings: DesignWarning[];
};

/** The normalised view of an already-parsed design.json value. Never throws. */
export const normalizeDesign = (raw: unknown, options: NormalizeOptions): NormalizedDesign => {
  const warnings = new Warnings();
  const record: Rec = isRec(raw) ? raw : {};
  if (!isRec(raw)) warnings.add('invalid-design-json', undefined, 'design.json is not a JSON object, so defaults are shown.');

  if (has(record, 'version') && record.version !== DESIGN_JSON_VERSION) {
    warnings.add('unsupported-version', 'version', `design.json says version ${String(record.version)}; this Design Chamber reads version ${DESIGN_JSON_VERSION} and shows what it can.`);
  }

  let kind: DesignKind;
  if (options.kind) {
    kind = options.kind;
  } else if (isKind(record.kind)) {
    kind = record.kind;
  } else {
    kind = Array.isArray(record.screens) && record.screens.length > 0 ? 'canvas' : 'artifact';
    warnings.add('invalid-kind', 'kind', `design.json does not say whether this is an artifact or a canvas; it is shown as ${kind === 'canvas' ? 'a canvas' : 'an artifact'}.`);
  }

  let title = nonEmpty(record.title, TITLE_MAX);
  if (title === null) {
    if (has(record, 'title')) warnings.add('invalid-title', 'title', `The title must be 1–${TITLE_MAX} characters; "${options.fallbackTitle}" is shown instead.`);
    title = options.fallbackTitle;
  }

  const time = (key: 'created' | 'updated'): IsoDate => {
    const value = record[key];
    if (isIsoDate(value)) return value;
    if (value !== undefined) warnings.add(`invalid-${key}`, key, `The ${key} time in design.json is not an ISO date and is ignored.`);
    return options.fallbackTime;
  };

  let brief = '';
  if (typeof record.brief === 'string') {
    brief = record.brief.length > BRIEF_MAX ? record.brief.slice(0, BRIEF_MAX) : record.brief;
    if (record.brief.length > BRIEF_MAX) warnings.add('brief-truncated', 'brief', `The brief is over ${BRIEF_MAX} characters; the rest is not shown.`);
  } else if (record.brief !== undefined && record.brief !== null) {
    warnings.add('invalid-brief', 'brief', 'The brief in design.json is not text and is ignored.');
  }

  const sessionId = optionalString(record, 'sessionId', SESSION_ID_MAX, warnings, 'linked chat id');
  const projectDirectory = optionalString(record, 'projectDirectory', PROJECT_DIRECTORY_MAX, warnings, 'project folder');
  let preset = optionalString(record, 'preset', 60, warnings, 'preset');
  if (preset !== null && !PRESET_ID_PATTERN.test(preset)) {
    warnings.add('invalid-preset', 'preset', 'The preset in design.json is not a preset id and is ignored.');
    preset = null;
  }

  let entry: string | null = null;
  if (kind === 'artifact') {
    entry = ENTRY_FILE;
    if (has(record, 'entry') && record.entry !== ENTRY_FILE) {
      warnings.add('invalid-entry', 'entry', `An artifact always shows ${ENTRY_FILE}; the entry in design.json is ignored.`);
    }
  }

  const viewports = parseViewports(record, kind, warnings);
  const screens = parseScreens(record, kind, viewports, warnings);

  let designSystem: DesignSystemStatus = { confirmed: false };
  if (has(record, 'designSystem')) {
    const value = record.designSystem;
    if (isRec(value) && typeof value.confirmed === 'boolean') designSystem = { confirmed: value.confirmed };
    else warnings.add('invalid-design-system', 'designSystem', 'designSystem must be { "confirmed": true | false }; it is treated as not confirmed.');
  }

  const comments = parseComments(record, warnings);

  const extra: JsonObject = Object.fromEntries(
    // Safe: `record` came from JSON.parse (or is {}), so every value is JSON.
    Object.entries(record).filter(([key]) => !KNOWN_FIELDS.has(key)) as [string, JsonValue][],
  );

  return {
    design: {
      version: 1,
      kind,
      title,
      created: time('created'),
      updated: time('updated'),
      brief,
      sessionId,
      projectDirectory,
      preset,
      entry,
      viewports,
      screens,
      designSystem,
      comments,
    },
    extra,
    warnings: warnings.list,
  };
};

export type ParsedDesignFile = NormalizedDesign & {
  /** The parsed object, or `null` when the text was not a JSON object (the agent may be mid-write: never write over it). */
  raw: JsonObject | null;
};

/** Parse design.json text. Invalid JSON yields defaults, `raw: null` and an `invalid-json` warning. */
export const parseDesignJsonText = (text: string, options: NormalizeOptions): ParsedDesignFile => {
  let value: unknown;
  try {
    value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    const fallback = normalizeDesign({}, options);
    return { ...fallback, raw: null, warnings: [{ code: 'invalid-json', message: 'design.json is not valid JSON yet, so defaults are shown until the agent fixes it.' }, ...fallback.warnings] };
  }
  const normalized = normalizeDesign(value, options);
  // Safe: JSON.parse output that is a non-array object is a JsonObject.
  return { ...normalized, raw: isRec(value) ? (value as JsonObject) : null };
};

// ---- .chamber/state.json [§6.3] ----

/** Read state.json content. `null` when it is unusable (the store then rebuilds state from design.json). */
export const normalizeServiceState = (raw: unknown): ServiceState | null => {
  if (!isRec(raw) || raw.version !== STATE_JSON_VERSION || !isKind(raw.kind) || !isIsoDate(raw.created)) return null;
  const check = new Warnings();
  const brief = typeof raw.brief === 'string' ? raw.brief.slice(0, BRIEF_MAX) : '';
  const sessionId = optionalString(raw, 'sessionId', SESSION_ID_MAX, check, '');
  const projectDirectory = optionalString(raw, 'projectDirectory', PROJECT_DIRECTORY_MAX, check, '');
  const presetValue = optionalString(raw, 'preset', 60, check, '');
  const preset = presetValue !== null && PRESET_ID_PATTERN.test(presetValue) ? presetValue : null;
  const comments = parseComments(raw, check);
  return {
    version: 1,
    kind: raw.kind,
    created: raw.created,
    brief,
    sessionId,
    projectDirectory,
    preset,
    entry: raw.kind === 'artifact' ? ENTRY_FILE : null,
    comments,
  };
};

/** The service-owned fields of a normalised design (used to seed state.json for a folder that had none). */
export const serviceStateOf = (design: DesignJson): ServiceState => ({
  version: 1,
  kind: design.kind,
  created: design.created,
  brief: design.brief,
  sessionId: design.sessionId,
  projectDirectory: design.projectDirectory,
  preset: design.preset,
  entry: design.kind === 'artifact' ? ENTRY_FILE : null,
  comments: design.comments,
});

/** The view the service answers: design.json's agent fields with state.json's service fields on top. */
export const applyServiceState = (design: DesignJson, state: ServiceState): DesignJson => ({
  ...design,
  version: 1,
  kind: state.kind,
  created: state.created,
  brief: state.brief,
  sessionId: state.sessionId,
  projectDirectory: state.projectDirectory,
  preset: state.preset,
  entry: state.kind === 'artifact' ? ENTRY_FILE : null,
  comments: state.comments,
});

const stateValue = (state: ServiceState, key: ServiceOwnedField): JsonValue | undefined => {
  if (key === 'entry') return state.kind === 'artifact' ? ENTRY_FILE : undefined;
  // Safe: every ServiceState field is plain JSON (strings, nulls, numbers, Comment objects).
  return state[key] as unknown as JsonValue;
};

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** True when design.json's mirror of any service-owned field differs from state.json (§6.3 merge trigger). */
export const serviceFieldsDiffer = (raw: JsonObject, state: ServiceState): boolean =>
  SERVICE_OWNED_FIELDS.some((key) => !sameJson(has(raw, key) ? raw[key] : undefined, stateValue(state, key)));

/** Agent-owned values the service itself writes: a user rename, and the `updated` bump on service writes. */
export type ServiceWrite = { title?: string; updated?: IsoDate };

/**
 * design.json with state.json's service-owned fields merged into the agent's raw object.
 * Key order and every other key (agent fields, unknown keys, even invalid values) are kept;
 * missing service keys are appended. Never call it with a file that failed to parse.
 */
export const mergeServiceFields = (raw: JsonObject, state: ServiceState, write: ServiceWrite = {}): JsonObject => {
  const replacements = new Map<string, JsonValue | undefined>();
  for (const key of SERVICE_OWNED_FIELDS) replacements.set(key, stateValue(state, key));
  if (write.title !== undefined) replacements.set('title', write.title);
  if (write.updated !== undefined) replacements.set('updated', write.updated);

  const entries: [string, JsonValue][] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (!replacements.has(key)) {
      entries.push([key, value]);
      continue;
    }
    const next = replacements.get(key);
    replacements.delete(key);
    if (next !== undefined) entries.push([key, next]);
  }
  for (const key of CANONICAL_ORDER) {
    if (!replacements.has(key)) continue;
    const next = replacements.get(key);
    if (next !== undefined) entries.push([key, next]);
  }
  return Object.fromEntries(entries);
};

/** The exact bytes the service writes for a JSON file (stable, so equal content means equal bytes). */
export const serializeJson = (value: JsonValue): string => `${JSON.stringify(value, null, 2)}\n`;

export type NewDesignInput = {
  kind: DesignKind;
  title: string;
  brief: string;
  sessionId: string | null;
  projectDirectory: string | null;
  preset: string | null;
  now: IsoDate;
};

/** state.json and design.json content for a design the service creates (§9.3). */
export const createDesignDocument = (input: NewDesignInput): { state: ServiceState; json: JsonObject } => {
  const state: ServiceState = {
    version: 1,
    kind: input.kind,
    created: input.now,
    brief: input.brief.slice(0, BRIEF_MAX),
    sessionId: input.sessionId,
    projectDirectory: input.projectDirectory,
    preset: input.preset,
    entry: input.kind === 'artifact' ? ENTRY_FILE : null,
    comments: [],
  };
  const agentPart: JsonObject = {
    title: input.title,
    updated: input.now,
    viewports: defaultViewports(input.kind),
    ...(input.kind === 'canvas' ? { screens: [] } : {}),
    designSystem: { confirmed: false },
  };
  return { state, json: orderCanonically(mergeServiceFields(agentPart, state)) };
};

const orderCanonically = (value: JsonObject): JsonObject =>
  Object.fromEntries(CANONICAL_ORDER.filter((key) => has(value, key)).map((key) => [key, value[key] as JsonValue]));

/** design.json as stored in a version snapshot: comments removed (§6.4). */
export const stripForVersion = (raw: JsonObject): JsonObject =>
  Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'comments'));
