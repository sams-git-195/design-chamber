// View-model of the settings screens (R3, P5): folder validation and the opencode.json tip.

import { SETTINGS_PATH_MAX } from '../../shared/limits.ts';

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const UNC = /^\\\\[^\\]+\\[^\\]+/;

export const isAbsolutePath = (path: string): boolean => path.startsWith('/') || path.startsWith('~/') || WINDOWS_ABSOLUTE.test(path) || UNC.test(path);

/** A filesystem root alone ("/", "C:\") is refused by the service too; say so before the round trip. */
const isFilesystemRoot = (path: string): boolean => path === '/' || /^[A-Za-z]:[\\/]?$/.test(path);

/** Inline validation for the folder field. `null` = fine to apply. */
export const validateRootInput = (input: string, currentRoot: string): string | null => {
  const value = input.trim();
  if (value === '') return 'Enter the full path of a folder, or choose “Use default”.';
  if (value.length > SETTINGS_PATH_MAX) return 'That path is too long.';
  if (value.includes('\0')) return 'That path contains a character folders cannot have.';
  if (!isAbsolutePath(value)) return 'Use the full path, starting with a drive letter (C:\\…) or “/”.';
  if (isFilesystemRoot(value)) return 'Choose a folder inside the drive, not the drive itself.';
  if (value === currentRoot) return 'This is already your designs folder.';
  return null;
};

/** opencode.json globs use forward slashes on every OS. */
export const permissionSnippet = (root: string): string => {
  const glob = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/**`;
  return JSON.stringify({ permission: { external_directory: { [glob]: 'allow' } } }, null, 2);
};

export const designCountLabel = (count: number): string => (count === 1 ? '1 design' : `${count} designs`);

export type BrowserStatus = { tone: 'success' | 'warning'; title: string; detail: string };

export const browserStatus = (path: string | null, source: 'setting' | 'detected' | 'none'): BrowserStatus => {
  if (path === null || source === 'none') {
    return { tone: 'warning', title: 'Not found', detail: 'Thumbnails use live previews until a Chrome, Edge or Chromium is available.' };
  }
  return { tone: 'success', title: source === 'setting' ? 'Using your chosen browser' : 'Detected automatically', detail: path };
};
