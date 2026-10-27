// WP3 — GET /presets (docs/SPEC.md §7, §11), and the readers of `rules/**` the instruction
// builders use. `rules/` is read from `ctx.packageRoot` on every call, so editing a rules file
// needs no rebuild (§9.7).

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { parsePreset } from '../../shared/agent/presets.ts';
import type { RulesDocFiles } from '../../shared/agent/rules-doc.ts';
import type { PresetsResponse } from '../../shared/api.ts';
import { PRESET_ID_PATTERN } from '../../shared/limits.ts';
import type { Preset } from '../../shared/types.ts';
import type { Logger, ServiceContext } from '../context.ts';
import { ApiError, type Router } from '../http.ts';

const presetsDir = (packageRoot: string): string => path.join(packageRoot, 'rules', 'presets');

/**
 * A bundled rules file as LF text: a checkout or unzip that turned it into CRLF must not
 * change the RULES.md and chip bytes the agent reads (the same on every platform).
 */
const readRulesText = async (file: string): Promise<string> => (await readFile(file, 'utf8')).replace(/\r\n?/g, '\n');

const notReadable = (what: string): ApiError =>
  new ApiError('internal', `Design Chamber could not read its bundled ${what}. Reinstall the extension; if that does not help, report it.`);

/** The bundled presets, by name. A preset file that does not parse is skipped and logged. */
export const listPresets = async (packageRoot: string, log: Logger): Promise<Preset[]> => {
  const names = await readdir(presetsDir(packageRoot)).catch((error: unknown) => {
    log.warn('presets.dir-unreadable', { error: error instanceof Error ? error.message : String(error) });
    return [] as string[];
  });
  const presets: Preset[] = [];
  for (const name of names.filter((entry) => entry.toLowerCase().endsWith('.md')).sort()) {
    const stem = name.slice(0, -'.md'.length);
    const text = await readRulesText(path.join(presetsDir(packageRoot), name)).catch(() => null);
    const preset = text === null ? null : parsePreset(stem, text);
    if (preset) presets.push(preset);
    else log.warn('presets.file-skipped', { file: name });
  }
  return presets.sort((a, b) => a.name.localeCompare(b.name, 'en'));
};

/** One preset with its verbatim text; `null` when the id is not a bundled preset. */
export const readPreset = async (packageRoot: string, id: string): Promise<{ preset: Preset; text: string } | null> => {
  // The id pattern has no separators or dots, so the file name cannot leave `rules/presets/`.
  if (!PRESET_ID_PATTERN.test(id)) return null;
  const text = await readRulesText(path.join(presetsDir(packageRoot), `${id}.md`)).catch(() => null);
  const preset = text === null ? null : parsePreset(id, text);
  return preset && text !== null ? { preset, text } : null;
};

/** `rules/DESIGN-RULES.md` and `rules/QUESTIONS.md`, verbatim. Throws `internal` when either is missing. */
export const readRulesDocs = async (packageRoot: string): Promise<RulesDocFiles> => {
  const read = (name: string): Promise<string> =>
    readRulesText(path.join(packageRoot, 'rules', name)).catch(() => {
      throw notReadable(`design rules (rules/${name})`);
    });
  // In order, so the first missing file is the one named.
  const designRules = await read('DESIGN-RULES.md');
  return { designRules, questions: await read('QUESTIONS.md') };
};

/**
 * Registers:
 * - 'GET /presets'
 * No request input reaches the filesystem: the file names come from listing `rules/presets/`.
 */
export function registerPresetsRoutes(router: Router, ctx: ServiceContext): void {
  router.on('GET /presets', async (): Promise<PresetsResponse> => ({ presets: await listPresets(ctx.packageRoot, ctx.log) }));
}
