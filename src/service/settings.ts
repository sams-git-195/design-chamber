// Service-owned settings file (docs/SPEC.md §6.5, §9.2) — port of design-canvas
// `service/settings.ts`, renamed for Design Chamber.
//
// One small JSON file per user, outside the designs root, holding where designs live:
// `{ version: 1, root?, previousRoots?, chromePath?, downloadsDir? }`. Guests never read or
// write it — GET/PUT /settings are the only door. Location:
//   win32   %APPDATA%\Design Chamber\settings.json   (fallback ~\AppData\Roaming\…)
//   darwin  ~/Library/Application Support/Design Chamber/settings.json
//   else    ${XDG_CONFIG_HOME:-~/.config}/design-chamber/settings.json
// `DC_SETTINGS_PATH` overrides the file location (test seam only — the host never passes
// custom env, F9). A corrupt file reads as absent and is logged; writes are atomic.
// Changing `root` pushes the old root onto `previousRoots` (newest first, ≤ 10) and NEVER
// moves files; listeners registered via `onRootChange` (the watcher) are notified after the
// write succeeded.

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { PutSettingsBody } from '../shared/api.ts';
import { PREVIOUS_ROOTS_MAX, SETTINGS_FILE_VERSION, SETTINGS_PATH_MAX } from '../shared/limits.ts';
import type { SettingsFile } from '../shared/types.ts';
import type { Logger, SettingsStore } from './context.ts';
import { ApiError } from './http.ts';
import { defaultDesignsRoot, sameRoot, validateRootCandidate } from './root.ts';
import { writeFileAtomic } from './paths.ts';

export type SettingsEnv = {
  DC_SETTINGS_PATH?: string;
  APPDATA?: string;
  XDG_CONFIG_HOME?: string;
};

/** Absolute settings file path for the platform (`DC_SETTINGS_PATH` wins). */
export const settingsFilePath = (
  env: SettingsEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDir: string = os.homedir(),
): string => {
  const override = env.DC_SETTINGS_PATH;
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override.trim());
  if (platform === 'win32') {
    const appData = env.APPDATA && env.APPDATA.trim() !== '' ? env.APPDATA : path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'Design Chamber', 'settings.json');
  }
  if (platform === 'darwin') {
    return path.join(homeDir, 'Library', 'Application Support', 'Design Chamber', 'settings.json');
  }
  const xdg = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' ? env.XDG_CONFIG_HOME : path.join(homeDir, '.config');
  return path.join(xdg, 'design-chamber', 'settings.json');
};

/** Keep only well-typed fields; anything else in the file is dropped. */
export const normalizeSettings = (raw: unknown): SettingsFile => {
  const out: SettingsFile = { version: SETTINGS_FILE_VERSION };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const value = raw as Partial<Record<keyof SettingsFile, unknown>>;
  const text = (candidate: unknown): string | null =>
    typeof candidate === 'string' && candidate.trim() !== '' && candidate.length <= SETTINGS_PATH_MAX ? candidate : null;
  const root = text(value.root);
  if (root !== null) out.root = root;
  const chromePath = text(value.chromePath);
  if (chromePath !== null) out.chromePath = chromePath;
  const downloadsDir = text(value.downloadsDir);
  if (downloadsDir !== null) out.downloadsDir = downloadsDir;
  if (Array.isArray(value.previousRoots)) {
    const roots = value.previousRoots.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '');
    if (roots.length > 0) out.previousRoots = roots.slice(0, PREVIOUS_ROOTS_MAX);
  }
  return out;
};

/** Parse settings text. Corrupt JSON = absent (`null`) so callers fall back and log. */
export const parseSettings = (text: string): SettingsFile | null => {
  try {
    return normalizeSettings(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
};

/** Read the settings file; a missing or corrupt file answers `{ version: 1 }` (corrupt is signalled). */
export const readSettingsFile = async (file: string): Promise<{ settings: SettingsFile; corrupt: boolean }> => {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { settings: { version: SETTINGS_FILE_VERSION }, corrupt: false };
  }
  const parsed = parseSettings(text);
  if (parsed === null) return { settings: { version: SETTINGS_FILE_VERSION }, corrupt: true };
  return { settings: parsed, corrupt: false };
};

/** Atomically write the settings file (tmp + rename), creating its folder. */
export const writeSettingsFile = async (file: string, settings: SettingsFile): Promise<void> => {
  await writeFileAtomic(file, `${JSON.stringify(normalizeSettings(settings), null, 2)}\n`);
};

export type SettingsStoreOptions = {
  log: Logger;
  /** The extension package folder; a root inside it is refused. */
  packageRoot: string;
  /** Test seam: `DC_SETTINGS_PATH` and friends. Defaults to `process.env`. */
  env?: SettingsEnv;
  platform?: NodeJS.Platform;
  homeDir?: string;
};

/**
 * The live settings store. `createSettingsStore` reads the file once (corrupt → defaults +
 * a warning); `read()` then answers from cache and `update()` validates, persists atomically
 * and notifies root-change listeners.
 */
export const createSettingsStore = async (options: SettingsStoreOptions): Promise<SettingsStore> => {
  const { log, packageRoot } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const file = settingsFilePath(env, platform, homeDir);

  const initial = await readSettingsFile(file);
  if (initial.corrupt) log.warn('settings.corrupt', { file, message: 'The settings file could not be read; defaults are used.' });
  let current: SettingsFile = initial.settings;

  const rootHost = { platform, env };
  const defaultRoot = defaultDesignsRoot(homeDir, rootHost);
  const rootListeners = new Set<(root: string, previous: string) => void>();
  const rootOf = (candidate: SettingsFile): string =>
    typeof candidate.root === 'string' && candidate.root.trim() !== '' ? path.resolve(candidate.root) : defaultRoot;

  const store: SettingsStore = {
    root: () => rootOf(current),
    defaultRoot: () => defaultRoot,
    read: () => current,
    async update(patch: PutSettingsBody): Promise<SettingsFile> {
      const previousRoot = store.root();
      const next: SettingsFile = { ...current };

      let rootChanges = false;
      if (patch.root !== undefined) {
        if (patch.root === null) {
          delete next.root;
        } else {
          const validated = await validateRootCandidate(patch.root, { packageRoot, homeDir, host: rootHost });
          if (!validated.ok) throw new ApiError('bad-path', validated.message);
          next.root = validated.root;
        }
        rootChanges = !sameRoot(rootOf(next), previousRoot);
        // The old root always joins previousRoots on a real switch — even one that looks
        // empty now (a design may land there later, or the count may have failed) — so
        // nothing the user made disappears from the "Switch back" list. Files are NEVER
        // moved (BRIEF: existing designs are not silently moved).
        const nextRoot = rootOf(next);
        const previous = (next.previousRoots ?? []).filter((entry) => !sameRoot(entry, nextRoot) && !sameRoot(entry, previousRoot));
        if (rootChanges) next.previousRoots = [previousRoot, ...previous].slice(0, PREVIOUS_ROOTS_MAX);
        else if (previous.length > 0) next.previousRoots = previous;
        else delete next.previousRoots;
      }
      if (patch.chromePath !== undefined) {
        if (patch.chromePath === null) {
          delete next.chromePath;
        } else {
          const value = patch.chromePath.trim();
          if (value === '' || value.includes('\0') || value.length > SETTINGS_PATH_MAX) {
            throw new ApiError('bad-path', 'That browser path is not usable — give the full path to the browser executable.');
          }
          next.chromePath = value;
        }
      }

      try {
        await writeSettingsFile(file, next);
      } catch (error) {
        throw new ApiError('internal', `Could not save the settings file: ${error instanceof Error ? error.message : String(error)}`);
      }
      current = normalizeSettings(next);
      if (rootChanges) {
        const newRoot = store.root();
        log.info('settings.root-changed', { from: previousRoot, to: newRoot });
        for (const listener of [...rootListeners]) {
          try {
            listener(newRoot, previousRoot);
          } catch (error) {
            log.error('settings.root-listener-failed', { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }
      return current;
    },
    onRootChange(listener) {
      rootListeners.add(listener);
      return () => rootListeners.delete(listener);
    },
  };
  return store;
};
