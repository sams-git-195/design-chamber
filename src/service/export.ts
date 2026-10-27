// Export delivery (docs/SPEC.md §4.3, §9.5): guests cannot download (F1, F10), so the service
// writes the file itself — to `settings.downloadsDir ?? <Downloads>` (the XDG Download folder
// on Linux, user-dirs.ts), falling back to `<root>/.exports/` when that folder is missing — and
// answers the path for the toast's "Show in folder" (reveal only accepts paths issued here).
//
//   ZIP:  `<slug>/` tree of every tracked file except design.json (internal)
//   HTML: bundleDocument output WITHOUT the bridge — artifact index.html, or the chosen screen
//
// Names get ` (2)`, ` (3)`… on collision; writes are atomic (tmp + rename in the same folder).

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { ExportBody, ExportResponse } from '../shared/api.ts';
import { DESIGN_JSON_FILE } from '../shared/design-json.ts';
import { ApiError } from './http.ts';
import type { DesignRecord, DesignStore, Logger, SettingsStore } from './context.ts';
import { BundleMissingEntry, BundleTooLarge, bundleDocument, createLiveFileSource } from './bundle.ts';
import { resolveEntryFile } from './render-cache.ts';
import { folderErrorSentence } from './root.ts';
import { userDir } from './user-dirs.ts';
import { listTracked } from './versions.ts';
import { createZip } from './zip.ts';

const NAME_COLLISION_TRIES = 1000;

export type ExportDeps = {
  store: DesignStore;
  settings: SettingsStore;
  log: Logger;
  /** Record a path so /reveal will accept it. */
  issue: (absolutePath: string) => void;
  /** Injectable for tests: overrides `settings.downloadsDir ?? ~/Downloads`. */
  downloadsDir?: () => string;
};

export type ExportService = {
  export(slug: string, body: ExportBody): Promise<ExportResponse>;
};

const defaultDownloads = (): string => userDir('DOWNLOAD');

/** The folder exports go to: the configured (or default) Downloads when usable, else `<root>/.exports`. */
const destinationDir = async (deps: ExportDeps): Promise<string> => {
  const preferred = deps.downloadsDir ? deps.downloadsDir() : (deps.settings.read().downloadsDir ?? defaultDownloads());
  const fallback = path.join(deps.settings.root(), '.exports');
  for (const candidate of [preferred, fallback]) {
    try {
      await mkdir(candidate, { recursive: true });
      if (existsSync(candidate)) return candidate;
    } catch {
      // try the fallback
    }
  }
  throw new ApiError('internal', 'Design Chamber could not find a folder to save the export in.');
};

const uniqueTarget = (dir: string, baseName: string): string => {
  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);
  let candidate = path.join(dir, baseName);
  for (let n = 2; existsSync(candidate) && n <= NAME_COLLISION_TRIES; n += 1) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  if (existsSync(candidate)) throw new ApiError('conflict', 'Too many files with this name already exist in the export folder.');
  return candidate;
};

const writeAtomic = async (target: string, bytes: Uint8Array): Promise<void> => {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error instanceof Error ? error : new Error(String(error));
  }
};

const buildZip = async (slug: string, record: DesignRecord): Promise<Buffer> => {
  const rels = (await listTracked(record.path)).filter((rel) => rel !== DESIGN_JSON_FILE);
  if (rels.length === 0) throw new ApiError('no-html', 'This design has no files to export yet.');
  const entries: { name: string; data: Uint8Array }[] = [];
  for (const rel of rels) {
    const bytes = await readFile(path.join(record.path, ...rel.split('/'))).catch(() => null);
    if (bytes === null) continue; // vanished mid-export: the ZIP simply lacks it
    entries.push({ name: `${slug}/${rel}`, data: bytes });
  }
  if (entries.length === 0) throw new ApiError('no-html', 'This design has no files to export yet.');
  return createZip(entries);
};

const buildHtml = async (record: DesignRecord, entryRel: string): Promise<Buffer> => {
  const source = createLiveFileSource(record.path);
  try {
    const result = await bundleDocument(source, entryRel, { mode: 'export' });
    return Buffer.from(result.html, 'utf8');
  } catch (error) {
    if (error instanceof BundleMissingEntry) throw new ApiError('no-html', `The document for this view (${entryRel}) has not been written yet.`);
    if (error instanceof BundleTooLarge) throw new ApiError('too-large', 'This design is too large to export as a single file. Export the ZIP instead.');
    throw error;
  }
};

export const createExportService = (deps: ExportDeps): ExportService => ({
  async export(slug: string, body: ExportBody): Promise<ExportResponse> {
    if (body.format !== 'zip' && body.format !== 'html') {
      throw new ApiError('bad-request', 'The export format must be "zip" or "html".');
    }
    const screen = typeof body.screen === 'string' && body.screen !== '' ? body.screen : undefined;
    const record = await deps.store.get(slug);

    let bytes: Buffer;
    let baseName: string;
    if (body.format === 'zip') {
      bytes = await buildZip(slug, record);
      baseName = `${slug}.zip`;
    } else {
      const { entryRel, screenId } = resolveEntryFile(record.design, record.files, screen);
      bytes = await buildHtml(record, entryRel);
      baseName = screenId === null ? `${slug}.html` : `${slug}-${screenId}.html`;
    }

    const dir = await destinationDir(deps);
    const target = uniqueTarget(dir, baseName);
    try {
      await writeAtomic(target, bytes);
    } catch (error) {
      // macOS can refuse ~/Downloads to OpenChamber (privacy) even though the folder exists.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM' || code === 'EACCES') throw new ApiError('bad-path', folderErrorSentence(error, dir));
      throw error;
    }
    deps.issue(target);
    deps.log.info('export.written', { slug, format: body.format, bytes: bytes.length });
    return { path: target, bytes: bytes.length, format: body.format };
  },
});
