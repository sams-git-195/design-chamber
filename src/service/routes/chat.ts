// WP3 — POST /chip, POST /designs/:slug/prompt, POST /artifacts/from-message, DELETE /open-request (docs/SPEC.md §7, §10, §11),
// and the `onCreate` hook that writes `<design>/.chamber/RULES.md`.

import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildChip, titleFromBrief } from '../../shared/agent/chip.ts';
import { noProject, type AgentContext, type AgentPreset, type ProjectRules } from '../../shared/agent/context.ts';
import { deriveArtifactTitle, extractHtml } from '../../shared/agent/html-extract.ts';
import { buildContinuePrompt, buildRevisionPrompt } from '../../shared/agent/revision-prompt.ts';
import { buildRulesDoc } from '../../shared/agent/rules-doc.ts';
import type { ChipResponse, FromMessageResponse, OpenRequest, OpenRequestResponse, PromptBody, PromptResponse } from '../../shared/api.ts';
import {
  BRIEF_MAX,
  COMMENT_ID_PATTERN,
  COMMENTS_MAX,
  DISCOVERY_TIME_MAX_MS,
  OPEN_REQUEST_TTL_MS,
  PRESET_ID_PATTERN,
  PROJECT_DIRECTORY_MAX,
  SESSION_ID_MAX,
  UPLOAD_ID_PATTERN,
} from '../../shared/limits.ts';
import type { AnchorState, Comment, DesignKind } from '../../shared/types.ts';
import type { DesignRecord, ServiceContext } from '../context.ts';
import { discoverProjectRules, withDeadline } from '../discovery.ts';
import { ApiError, type Router } from '../http.ts';
import { readPreset, readRulesDocs } from './presets.ts';

// ---- request validation (every body here is untrusted) ----

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

const bodyOf = (body: unknown, what: string): Rec => {
  if (!isRec(body)) throw new ApiError('bad-request', `Send ${what} as a JSON object.`);
  return body;
};

const optionalText = (record: Rec, key: string, max: number, label: string): string | null => {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > max) throw new ApiError('bad-request', `The ${label} must be text of at most ${max} characters.`);
  return value;
};

/** An absolute project folder, or `null`. Relative paths and NUL are refused; nothing is touched here. */
export const projectDirectoryOf = (value: unknown): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > PROJECT_DIRECTORY_MAX) throw new ApiError('bad-request', `The project folder must be text of at most ${PROJECT_DIRECTORY_MAX} characters.`);
  if (value.trim() === '') return null;
  if (value.includes('\0') || !path.isAbsolute(value)) throw new ApiError('bad-path', 'The project folder must be an absolute path.');
  return value;
};

const parseChipBody = (body: unknown): { kind: DesignKind; brief: string; preset: string | null; projectDirectory: string | null } => {
  const record = bodyOf(body, 'the new design');
  const { kind } = record;
  if (kind !== 'canvas' && kind !== 'artifact') throw new ApiError('bad-request', 'Say whether the design is a "canvas" or an "artifact".');
  const brief = (optionalText(record, 'brief', Number.MAX_SAFE_INTEGER, 'brief') ?? '').trim();
  if (brief.length > BRIEF_MAX) {
    throw new ApiError('invalid', `The brief is ${brief.length} characters; Design Chamber keeps ${BRIEF_MAX}. Shorten it, or send the extra detail in the chat after the command.`);
  }
  const preset = optionalText(record, 'preset', 60, 'style preset');
  if (preset !== null && !PRESET_ID_PATTERN.test(preset)) throw new ApiError('bad-request', 'That is not a style preset id.');
  // `sessionId` is accepted but deliberately not stored: the user may never send the chip (§10.1).
  optionalText(record, 'sessionId', SESSION_ID_MAX, 'chat id');
  return { kind, brief, preset, projectDirectory: projectDirectoryOf(record.projectDirectory) };
};

const ANCHOR_STATES: ReadonlySet<unknown> = new Set<AnchorState>(['exact', 'moved', 'detached']);

/** `{ [commentId]: AnchorState }` from the page; absent = no flags. */
const parseAnchorStates = (value: unknown): Record<string, AnchorState> => {
  if (value === undefined || value === null) return {};
  const entries = isRec(value) ? Object.entries(value) : null;
  if (entries === null || entries.length > COMMENTS_MAX || !entries.every(([id, state]) => COMMENT_ID_PATTERN.test(id) && ANCHOR_STATES.has(state))) {
    throw new ApiError('bad-request', 'The pin states are not valid.');
  }
  // Safe: every value was just checked against ANCHOR_STATES.
  return Object.fromEntries(entries) as Record<string, AnchorState>;
};

const parsePromptBody = (body: unknown): { purpose: PromptBody['purpose']; commentIds: string[] | null; anchorStates: Record<string, AnchorState> } => {
  const record = bodyOf(body, 'the prompt request');
  const { purpose, commentIds } = record;
  if (purpose !== 'revision' && purpose !== 'continue') throw new ApiError('bad-request', 'The prompt purpose must be "revision" or "continue".');
  const anchorStates = parseAnchorStates(record.anchorStates);
  if (commentIds === undefined) return { purpose, commentIds: null, anchorStates };
  const ids = Array.isArray(commentIds) ? commentIds.filter((id): id is string => typeof id === 'string' && COMMENT_ID_PATTERN.test(id)) : [];
  if (!Array.isArray(commentIds) || commentIds.length > COMMENTS_MAX || ids.length !== commentIds.length) throw new ApiError('bad-request', 'The comment list is not valid.');
  return { purpose, commentIds: ids, anchorStates };
};

const parseFromMessageBody = (body: unknown): { uploadId: string; sessionId: string; sessionTitle: string; directory: string | null; open: boolean } => {
  const record = bodyOf(body, 'the message');
  const { uploadId, sessionId, sessionTitle, messageId } = record;
  if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) throw new ApiError('bad-request', 'The message upload id is not valid.');
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > SESSION_ID_MAX) throw new ApiError('bad-request', 'The chat id is not valid.');
  if (typeof messageId !== 'string' || messageId.length < 1 || messageId.length > 256) throw new ApiError('bad-request', 'The message id is not valid.');
  if (typeof sessionTitle !== 'string' || sessionTitle.length > 1000) throw new ApiError('bad-request', 'The chat title is not valid.');
  if (record.open !== undefined && typeof record.open !== 'boolean') throw new ApiError('bad-request', 'open must be true or false.');
  return { uploadId, sessionId, sessionTitle, directory: projectDirectoryOf(record.directory), open: record.open === true };
};

// ---- RULES.md on disk ----

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let tmpCounter = 0;

/**
 * Write `<folder>/.chamber/RULES.md` atomically (tmp + rename), skipping the write when the bytes
 * are unchanged. `folder` must already be a contained design folder (`store.dir` / a record's
 * `path`). The agent writes into the design folder too, so a `.chamber` that is a link or a
 * plain file is refused rather than followed out of the folder.
 */
export const writeRulesFile = async (folder: string, text: string): Promise<void> => {
  const dir = path.join(folder, '.chamber');
  const info = await lstat(dir).catch((error: unknown) => {
    if (isMissing(error)) return null;
    throw error;
  });
  if (info !== null && (info.isSymbolicLink() || !info.isDirectory())) {
    throw new ApiError('internal', 'This design\'s .chamber entry is not a normal folder, so Design Chamber cannot write the agent instructions there. Remove it and try again.');
  }
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, 'RULES.md');
  if ((await readFile(target, 'utf8').catch(() => null)) === text) return;
  tmpCounter += 1;
  const tmp = `${target}.${process.pid}.${tmpCounter}.tmp`;
  await writeFile(tmp, text, 'utf8');
  try {
    // Windows refuses to rename over a file another process has open for a moment (an agent reading it).
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(tmp, target);
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (attempt >= 4 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
        await sleep(40 * attempt);
      }
    }
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
};

const isFile = (file: string): Promise<boolean> => stat(file).then((info) => info.isFile(), () => false);

// ---- instruction assembly ----

const DISCOVERY_CACHE_MS = 15_000;
const DISCOVERY_CACHE_MAX = 8;
/** The scan's own cap plus a second of slack, inside the chip's 3 s build budget. */
const DISCOVERY_DEADLINE_MS = DISCOVERY_TIME_MAX_MS + 1000;

type Instructions = {
  /** The agent context and RULES.md text for a design, from disk. Throws when `rules/` is unreadable. */
  prepare(record: DesignRecord): Promise<{ context: AgentContext; text: string }>;
  discover(directory: string | null): Promise<ProjectRules>;
};

const createInstructions = (ctx: ServiceContext): Instructions => {
  // One scan serves the chip route and the `onCreate` hook it triggers.
  const scans = new Map<string, { at: number; result: Promise<ProjectRules> }>();

  const discover = (directory: string | null): Promise<ProjectRules> => {
    if (directory === null) return Promise.resolve(noProject('no project folder was given'));
    const key = process.platform === 'win32' ? directory.toLowerCase() : directory;
    const cached = scans.get(key);
    if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) return cached.result;
    const result = withDeadline(
      discoverProjectRules(directory, { designsRoot: ctx.settings.root() }),
      DISCOVERY_DEADLINE_MS,
      { ...noProject('the folder did not answer in time', directory), state: 'unreadable' as const },
    );
    scans.delete(key);
    scans.set(key, { at: Date.now(), result });
    for (const oldest of scans.keys()) {
      if (scans.size <= DISCOVERY_CACHE_MAX) break;
      scans.delete(oldest);
    }
    return result;
  };

  const loadPreset = async (id: string | null): Promise<AgentPreset | null> => {
    if (id === null) return null;
    const found = await readPreset(ctx.packageRoot, id);
    if (found === null) ctx.log.warn('agent.preset-missing', { preset: id });
    return found === null ? null : { id: found.preset.id, name: found.preset.name, text: found.text };
  };

  return {
    discover,
    async prepare(record) {
      const { design } = record;
      const [files, preset, project, hasDesignMd, hasTokensCss] = await Promise.all([
        readRulesDocs(ctx.packageRoot),
        loadPreset(design.preset),
        discover(design.projectDirectory),
        isFile(path.join(record.path, 'DESIGN.md')),
        isFile(path.join(record.path, 'tokens.css')),
      ]);
      const context: AgentContext = {
        title: design.title,
        kind: design.kind,
        folder: record.path,
        brief: design.brief,
        project,
        preset,
        viewports: design.viewports,
        screenIds: design.screens.map((screen) => screen.id),
        pending: record.pending,
        designSystem: { confirmed: design.designSystem.confirmed, hasDesignMd, hasTokensCss },
      };
      return { context, text: buildRulesDoc(context, files) };
    },
  };
};

const selectComments = (all: readonly Comment[], ids: readonly string[] | null): Comment[] => {
  const picked = ids === null ? all.filter((comment) => comment.status === 'open') : all.filter((comment) => ids.includes(comment.id));
  if (picked.length === 0) throw new ApiError('invalid', ids === null ? 'There are no open comments to send.' : 'None of those comments exist any more.');
  return picked;
};

/**
 * Registers:
 * - 'POST /chip'
 * - 'POST /designs/:slug/prompt'
 * - 'POST /artifacts/from-message'
 * - 'DELETE /open-request'
 * and hooks design creation so every new design gets its `.chamber/RULES.md`.
 * Design folders come from `ctx.store` (slug pattern + containment, §9.1); the only path this
 * module adds is the fixed `.chamber/RULES.md`. The project folder is read-only input to discovery.
 */
export function registerChatRoutes(router: Router, ctx: ServiceContext): void {
  const instructions = createInstructions(ctx);
  // One slot, taken exactly once: a newer "Open as artifact" replaces an untaken older one.
  let openRequest: { request: OpenRequest; at: number } | null = null;

  try {
    ctx.onDispose(
      ctx.store.onCreate(async (record) => {
        const { text } = await instructions.prepare(record);
        await writeRulesFile(record.path, text);
      }),
    );
  } catch (error) {
    // Until the integration pass wires the real store (SPEC §14) its methods answer "not built yet".
    ctx.log.warn('agent.rules-hook-unavailable', { error: error instanceof Error ? error.message : String(error) });
  }

  router.on('POST /chip', async ({ body }): Promise<ChipResponse> => {
    const input = parseChipBody(body);
    if (input.preset !== null && (await readPreset(ctx.packageRoot, input.preset)) === null) {
      throw new ApiError('bad-request', 'That style preset is not available. Pick another or start without one.');
    }
    await instructions.discover(input.projectDirectory);
    const record = await ctx.store.create({
      kind: input.kind,
      title: titleFromBrief(input.brief, input.kind),
      brief: input.brief,
      preset: input.preset,
      projectDirectory: input.projectDirectory,
    });
    // The chip makes RULES.md mandatory reading, so a failure to write it is a failure of the chip.
    const { context, text } = await instructions.prepare(record);
    await writeRulesFile(record.path, text);
    return { slug: record.slug, chip: buildChip(context, { slug: record.slug, mode: 'new', folderUrl: pathToFileURL(record.path).href }) };
  });

  router.on('POST /designs/:slug/prompt', async ({ params, body }): Promise<PromptResponse> => {
    const input = parsePromptBody(body);
    const record = await ctx.store.get(params.slug);
    const { context, text: rulesText } = await instructions.prepare(record);
    try {
      await writeRulesFile(record.path, rulesText);
    } catch (error) {
      // A refresh that fails (a file lock) leaves the earlier RULES.md in place; the message can still go out.
      ctx.log.warn('agent.rules-refresh-failed', { slug: record.slug, error: error instanceof Error ? error.message : String(error) });
    }
    const chip = buildChip(context, { slug: record.slug, mode: 'continue', folderUrl: pathToFileURL(record.path).href });
    const { design } = record;

    if (input.purpose === 'continue') {
      const openComments = design.comments.filter((comment) => comment.status === 'open').length;
      return { text: buildContinuePrompt({ title: design.title, kind: design.kind, folder: record.path, openComments }), commentIds: [], omitted: [], chip };
    }

    const prompt = buildRevisionPrompt({
      title: design.title,
      kind: design.kind,
      folder: record.path,
      screens: design.screens,
      viewports: design.viewports,
      comments: selectComments(design.comments, input.commentIds),
      anchorStates: input.anchorStates,
    });
    return { text: prompt.text, commentIds: prompt.commentIds, omitted: prompt.omitted, chip };
  });

  router.on('POST /artifacts/from-message', async ({ body }): Promise<FromMessageResponse> => {
    const input = parseFromMessageBody(body);
    const messageText = ctx.uploads.take(input.uploadId);
    const html = extractHtml(messageText);
    if (html === null) throw new ApiError('no-html', 'This message has no HTML code block to open as an artifact.');
    const record = await ctx.store.create({
      kind: 'artifact',
      title: deriveArtifactTitle(messageText, html, input.sessionTitle),
      brief: '',
      preset: null,
      projectDirectory: input.directory,
      sessionId: input.sessionId,
      html,
    });
    // The background action opens the rail next; the rail takes this on mount or on `added`.
    if (input.open) openRequest = { request: { slug: record.slug, created: new Date().toISOString() }, at: Date.now() };
    return { slug: record.slug, title: record.design.title };
  });

  router.on('DELETE /open-request', (): OpenRequestResponse => {
    const taken = openRequest !== null && Date.now() - openRequest.at <= OPEN_REQUEST_TTL_MS ? openRequest.request : null;
    openRequest = null;
    return { request: taken };
  });
}
