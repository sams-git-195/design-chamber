// Chrome/Edge/Chromium discovery for thumbnails (docs/SPEC.md §9.5 chrome.ts, ported from
// openchamber-design-canvas service/browser.ts:39-59 and extended).
//
// The service environment is an allowlist (F9): NO ProgramFiles env var — so Windows probes
// literal install paths (plus LOCALAPPDATA, which IS in the allowlist). Order: the user's
// setting, then Chrome, then the other Chromium browsers. `source` tells the UI where the path
// came from (§7 /settings).
//
// Linux: every name on PATH first (the desktop merges the login shell's PATH into the host
// env), then the usual literal folders — a minimal PATH must not hide /usr/bin — then the
// Snap and Flatpak launchers, which thumbnails.ts feeds a work folder they can write to.
// macOS: each app bundle in /Applications, then ~/Applications.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { BrowserSource, SettingsFile } from '../shared/types.ts';

export type BrowserResolution = { path: string | null; source: BrowserSource };

export type BrowserHost = {
  platform?: NodeJS.Platform;
  env?: { LOCALAPPDATA?: string; PATH?: string };
  homeDir?: string;
};

const win32Candidates = (env: BrowserHost['env']): string[] => {
  const local = env?.LOCALAPPDATA ?? '';
  return [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ...(local === '' ? [] : [path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')]),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
};

/** App bundle name → executable inside it, in preference order. */
const DARWIN_APPS = ['Google Chrome', 'Google Chrome Canary', 'Chromium', 'Microsoft Edge', 'Brave Browser'] as const;

const darwinCandidates = (homeDir: string): string[] =>
  DARWIN_APPS.flatMap((app) =>
    ['/Applications', path.posix.join(homeDir, 'Applications')].map((dir) => path.posix.join(dir, `${app}.app`, 'Contents', 'MacOS', app)),
  );

const LINUX_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser'] as const;
const LINUX_DIRS = ['/usr/bin', '/usr/local/bin'] as const;
const FLATPAK_IDS = ['com.google.Chrome', 'org.chromium.Chromium', 'com.microsoft.Edge', 'com.brave.Browser'] as const;

const linuxCandidates = (env: BrowserHost['env'], homeDir: string): string[] => {
  const pathDirs = (env?.PATH ?? '').split(':').filter((dir) => dir.startsWith('/'));
  const onPath = LINUX_NAMES.flatMap((name) => pathDirs.map((dir) => path.posix.join(dir, name)));
  const literal = LINUX_NAMES.flatMap((name) => LINUX_DIRS.map((dir) => path.posix.join(dir, name)));
  const flatpakDirs = ['/var/lib/flatpak/exports/bin', path.posix.join(homeDir, '.local', 'share', 'flatpak', 'exports', 'bin')];
  const sandboxed = ['/snap/bin/chromium', ...FLATPAK_IDS.flatMap((id) => flatpakDirs.map((dir) => path.posix.join(dir, id)))];
  return [...new Set([...onPath, ...literal, ...sandboxed])];
};

/** Every place a browser is looked for on `platform`, in preference order. */
export const browserCandidates = (host: BrowserHost = {}): string[] => {
  const platform = host.platform ?? process.platform;
  const env = host.env ?? process.env;
  const homeDir = host.homeDir ?? os.homedir();
  if (platform === 'win32') return win32Candidates(env);
  if (platform === 'darwin') return darwinCandidates(homeDir);
  return linuxCandidates(env, homeDir);
};

/**
 * The browser to use for thumbnails: the user's setting when the file exists, else the first
 * installed candidate, else none (thumbnails become `unavailable` and the UI falls back to
 * live mini-frames). Pure enough to test with an injected probe and host.
 */
export const resolveBrowser = (
  settings: Pick<SettingsFile, 'chromePath'>,
  probe: (candidate: string) => boolean = existsSync,
  host: BrowserHost = {},
): BrowserResolution => {
  const configured = settings.chromePath;
  if (typeof configured === 'string' && configured.trim() !== '') {
    if (probe(configured)) return { path: configured, source: 'setting' };
    // A configured path that no longer exists must not block detection.
  }
  const found = browserCandidates(host).find((candidate) => probe(candidate));
  if (found) return { path: found, source: 'detected' };
  return { path: null, source: 'none' };
};
