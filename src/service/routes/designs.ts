// WP1 — GET /designs, POST /designs, GET /designs/:slug, PATCH /designs/:slug, DELETE /designs/:slug (docs/SPEC.md §7, §9.3).

import type {
  CreateDesignBody,
  CreateDesignResponse,
  DeleteDesignResponse,
  DesignDetailResponse,
  DesignListResponse,
  PatchDesignBody,
  PatchDesignResponse,
} from '../../shared/api.ts';
import {
  BRIEF_MAX,
  CREATE_INLINE_HTML_MAX,
  PRESET_ID_PATTERN,
  SESSION_ID_MAX,
  TITLE_MAX,
  UPLOAD_ID_PATTERN,
} from '../../shared/limits.ts';
import type { DesignKind } from '../../shared/types.ts';
import type { ServiceContext } from '../context.ts';
import { ApiError, type Router } from '../http.ts';
import { projectDirectoryOf } from './chat.ts';

const isBodyRecord = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body);

const optionalText = (value: unknown, max: number, label: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > max) {
    throw new ApiError('bad-request', `The ${label} must be text of at most ${max} characters.`);
  }
  return value;
};

const isKind = (value: unknown): value is DesignKind => value === 'artifact' || value === 'canvas';

const validateCreate = (ctx: ServiceContext, body: unknown): CreateDesignBody => {
  if (!isBodyRecord(body)) throw new ApiError('bad-request', 'The new-design request must be a JSON object.');
  if (!isKind(body.kind)) throw new ApiError('bad-request', 'A design is either an "artifact" or a "canvas".');

  const title = optionalText(body.title, TITLE_MAX, 'title');
  const brief = optionalText(body.brief, BRIEF_MAX, 'brief');
  const preset = optionalText(body.preset, 60, 'preset');
  const projectDirectory = body.projectDirectory === undefined ? undefined : projectDirectoryOf(body.projectDirectory);
  const sessionId = optionalText(body.sessionId, SESSION_ID_MAX, 'chat session id');
  if (title !== undefined && title !== null && title.trim().length === 0) throw new ApiError('bad-request', 'The title must not be empty.');
  if (preset !== undefined && preset !== null && !PRESET_ID_PATTERN.test(preset)) throw new ApiError('bad-request', 'That is not a preset id.');

  const html = body.html;
  const uploadId = body.uploadId;
  if (body.kind === 'canvas' && (html !== undefined || uploadId !== undefined)) {
    throw new ApiError('bad-request', 'A canvas starts as an empty folder — only artifacts take initial HTML.');
  }
  let initialHtml: string | undefined;
  if (typeof html === 'string') {
    if (html.length > CREATE_INLINE_HTML_MAX) {
      throw new ApiError('too-large', `Initial HTML over ${CREATE_INLINE_HTML_MAX.toLocaleString('en-US')} characters must arrive as an upload.`);
    }
    initialHtml = html;
  } else if (html !== undefined) {
    throw new ApiError('bad-request', 'The initial HTML must be text.');
  }
  if (uploadId !== undefined) {
    if (typeof uploadId !== 'string' || !UPLOAD_ID_PATTERN.test(uploadId)) throw new ApiError('bad-request', 'That is not an upload id.');
    if (initialHtml !== undefined) throw new ApiError('bad-request', 'Send the initial HTML either inline or as an upload, not both.');
    // take() throws not-found (unknown/expired) or conflict (incomplete) itself.
    initialHtml = ctx.uploads.take(uploadId);
  }

  return {
    kind: body.kind,
    ...(title !== undefined && title !== null ? { title } : {}),
    ...(brief !== undefined && brief !== null ? { brief } : {}),
    ...(preset !== undefined ? { preset } : {}),
    ...(projectDirectory !== undefined ? { projectDirectory } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(initialHtml !== undefined ? { html: initialHtml } : {}),
  };
};

const validatePatch = (body: unknown): PatchDesignBody => {
  if (!isBodyRecord(body)) throw new ApiError('bad-request', 'The update must be a JSON object.');
  const patch: PatchDesignBody = {};
  let fields = 0;
  if (body.title !== undefined) {
    const title = optionalText(body.title, TITLE_MAX, 'title');
    if (title === null || title === undefined || title.trim().length === 0) {
      throw new ApiError('bad-request', 'The title must be 1–120 characters of text.');
    }
    patch.title = title.trim();
    fields += 1;
  }
  if (body.sessionId !== undefined) {
    patch.sessionId = optionalText(body.sessionId, SESSION_ID_MAX, 'chat session id');
    fields += 1;
  }
  if (body.projectDirectory !== undefined) {
    patch.projectDirectory = projectDirectoryOf(body.projectDirectory);
    fields += 1;
  }
  if (fields === 0) throw new ApiError('bad-request', 'Say what to change: "title", "sessionId" and/or "projectDirectory".');
  return patch;
};

/**
 * Registers:
 * - 'GET /designs'
 * - 'POST /designs'
 * - 'GET /designs/:slug'
 * - 'PATCH /designs/:slug'
 * - 'DELETE /designs/:slug'
 * Every slug is validated by pattern and resolved through the containment function by the
 * store before any filesystem access.
 */
export function registerDesignsRoutes(router: Router, ctx: ServiceContext): void {
  router.on('GET /designs', async ({ query }): Promise<DesignListResponse> => {
    const q = query.get('q') ?? undefined;
    const kindParam = query.get('kind') ?? undefined;
    if (kindParam !== undefined && !isKind(kindParam)) throw new ApiError('bad-request', 'The kind filter is "artifact" or "canvas".');
    const designs = await ctx.store.list({ ...(q !== undefined ? { q } : {}), ...(kindParam !== undefined ? { kind: kindParam } : {}) });
    return { root: ctx.settings.root(), designs };
  });

  router.on('POST /designs', async ({ body }): Promise<CreateDesignResponse> => {
    const record = await ctx.store.create(validateCreate(ctx, body));
    return { slug: record.slug, path: record.path, design: record.design };
  });

  router.on('GET /designs/:slug', async ({ params }): Promise<DesignDetailResponse> => {
    const record = await ctx.store.get(params.slug);
    return {
      slug: record.slug,
      path: record.path,
      design: record.design,
      pending: record.pending,
      files: record.files,
      warnings: record.warnings,
    };
  });

  router.on('PATCH /designs/:slug', async ({ params, body }): Promise<PatchDesignResponse> => {
    const record = await ctx.store.patch(params.slug, validatePatch(body));
    return { design: record.design };
  });

  router.on('DELETE /designs/:slug', async ({ params }): Promise<DeleteDesignResponse> => ({
    trashedTo: await ctx.store.trash(params.slug),
  }));
}
