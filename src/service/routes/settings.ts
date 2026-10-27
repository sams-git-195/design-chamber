// WP1 — GET /settings, PUT /settings (docs/SPEC.md §7, §9.2).

import type { PreviousRoot, SettingsResponse } from '../../shared/api.ts';
import { SETTINGS_PATH_MAX } from '../../shared/limits.ts';
import { resolveBrowser } from '../chrome.ts';
import type { ServiceContext } from '../context.ts';
import { ApiError, type Router } from '../http.ts';
import { countDesigns, exampleDesignsFolder, isDirectory, resolveDownloadsDir } from '../root.ts';

const isBodyRecord = (body: unknown): body is Record<string, unknown> =>
  typeof body === 'object' && body !== null && !Array.isArray(body);

/** Assemble the §7 settings answer from the store (previousRoots carry live counts). */
const buildSettingsResponse = async (ctx: ServiceContext): Promise<SettingsResponse> => {
  const file = ctx.settings.read();
  const root = ctx.settings.root();
  const previousRoots: PreviousRoot[] = [];
  for (const entry of file.previousRoots ?? []) {
    const exists = await isDirectory(entry);
    previousRoots.push({ path: entry, exists, designCount: exists ? await countDesigns(entry) : 0 });
  }
  return {
    root,
    defaultRoot: ctx.settings.defaultRoot(),
    previousRoots,
    rootExists: await isDirectory(root),
    // The browser thumbnails will use: the user's setting when that file exists, else a detected install.
    chrome: resolveBrowser(file),
    downloadsDir: await resolveDownloadsDir(root, file.downloadsDir),
  };
};

const validateRoot = (raw: unknown): string | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0') || raw.length > SETTINGS_PATH_MAX) {
    throw new ApiError('bad-path', `The designs folder must be a full folder path (for example ${exampleDesignsFolder()}).`);
  }
  return raw;
};

const validateChromePath = (raw: unknown): string | null | undefined => {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  if (typeof raw !== 'string' || raw.trim() === '' || raw.includes('\0') || raw.length > SETTINGS_PATH_MAX) {
    throw new ApiError('bad-path', 'The browser path must be the full path to the browser executable.');
  }
  return raw;
};

/**
 * Registers:
 * - 'GET /settings'
 * - 'PUT /settings'
 */
export function registerSettingsRoutes(router: Router, ctx: ServiceContext): void {
  router.on('GET /settings', async (): Promise<SettingsResponse> => buildSettingsResponse(ctx));

  router.on('PUT /settings', async ({ body }): Promise<SettingsResponse> => {
    if (body !== undefined && !isBodyRecord(body)) throw new ApiError('bad-request', 'The settings update must be a JSON object.');
    const record = body ?? {};
    if (!('root' in record) && !('chromePath' in record)) {
      throw new ApiError('bad-request', 'Say what to change: "root" and/or "chromePath".');
    }
    const root = validateRoot(record.root);
    const chromePath = validateChromePath(record.chromePath);
    // The store validates the path itself (absolute, not a drive root, not inside the
    // extension, creatable — 400 bad-path), persists atomically and never moves files.
    await ctx.settings.update({
      ...(root !== undefined ? { root } : {}),
      ...(chromePath !== undefined ? { chromePath } : {}),
    });
    return buildSettingsResponse(ctx);
  });
}
