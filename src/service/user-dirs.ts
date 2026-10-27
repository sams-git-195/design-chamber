// The user's Documents and Downloads folders (docs/SPEC.md §9.2, §4.3).
//
// win32 and darwin: `~/Documents`, `~/Downloads`. Linux and other XDG systems: the folders the
// desktop configured in `${XDG_CONFIG_HOME:-~/.config}/user-dirs.dirs` — translated on a
// non-English install (`~/Dokumente`, `~/Téléchargements`) — else the English names.
// The file is parsed directly rather than spawning `xdg-user-dir`: that command is a shell
// script that only sources this same file, so the answer is identical without a process.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type UserDirKind = 'DOCUMENTS' | 'DOWNLOAD';

export type UserDirsHost = {
  platform?: NodeJS.Platform;
  env?: { XDG_CONFIG_HOME?: string };
  homeDir?: string;
  /** Test seam: the file's text, or null when it cannot be read. */
  readText?: (file: string) => string | null;
};

const FALLBACK_NAME: Readonly<Record<UserDirKind, string>> = { DOCUMENTS: 'Documents', DOWNLOAD: 'Downloads' };

const readTextOrNull = (file: string): string | null => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/**
 * `XDG_<NAME>_DIR="…"` lines → absolute folders, as xdg-user-dirs writes them: the value is
 * `$HOME/…` or an absolute path, with `\` escaping `"`, `\`, `$` and backticks. A value that is
 * `$HOME` itself means "disabled" and, like a relative or malformed value, is left out.
 */
export const parseUserDirs = (text: string, homeDir: string): Partial<Record<string, string>> => {
  const dirs: Partial<Record<string, string>> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*XDG_([A-Z]+)_DIR\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/.exec(line);
    if (!match) continue;
    const name = match[1] ?? '';
    const value = (match[2] ?? '').replace(/\\(.)/g, '$1');
    let resolved: string | null = null;
    if (value.startsWith('$HOME/')) resolved = path.join(homeDir, value.slice('$HOME/'.length));
    else if (value.startsWith('/')) resolved = value;
    if (resolved === null || resolved.includes('\0')) continue;
    const normalized = path.resolve(resolved);
    if (normalized === path.resolve(homeDir)) continue;
    dirs[name] = normalized;
  }
  return dirs;
};

/** The user's Documents or Downloads folder for this platform (never throws). */
export const userDir = (kind: UserDirKind, host: UserDirsHost = {}): string => {
  const platform = host.platform ?? process.platform;
  const homeDir = host.homeDir ?? os.homedir();
  const fallback = path.join(homeDir, FALLBACK_NAME[kind]);
  if (platform === 'win32' || platform === 'darwin') return fallback;
  const env = host.env ?? process.env;
  const configHome = env.XDG_CONFIG_HOME && env.XDG_CONFIG_HOME.trim() !== '' && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(homeDir, '.config');
  const text = (host.readText ?? readTextOrNull)(path.join(configHome, 'user-dirs.dirs'));
  if (text === null) return fallback;
  return parseUserDirs(text, homeDir)[kind] ?? fallback;
};
