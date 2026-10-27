// Designs-root resolution and validation (docs/SPEC.md §9.2, §6.5; BRIEF "Storage").
//
// The default root is `<Documents>/Designs` — `~/Documents`, or on Linux the XDG Documents
// folder (user-dirs.ts: translated installs say `~/Dokumente`). A user-chosen root is validated here
// (absolute, not a filesystem root, not inside the extension package, creatable+writable) —
// changing it NEVER moves files; the old root joins `previousRoots` (settings.ts) and keeps
// its designs, which the UI shows as "N designs remain in <old root>".
// Simplified port of design-canvas `service/workspace-root.ts` (no OneDrive probe: the host
// env allowlist has no ONEDRIVE, SPEC F9).

import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DESIGN_JSON_FILE, ENTRY_FILE } from '../shared/design-json.ts';
import { SETTINGS_PATH_MAX } from '../shared/limits.ts';
import { isInsideOrEqual, isSlug, samePath } from './paths.ts';
import { userDir, type UserDirsHost } from './user-dirs.ts';

/** The platform facts the root rules need; everything defaults to this machine. */
export type RootHost = Omit<UserDirsHost, 'homeDir'>;

/** `<Documents>/Designs` (BRIEF default; no ONEDRIVE probe — F9). */
export const defaultDesignsRoot = (homeDir: string = os.homedir(), host: RootHost = {}): string =>
  path.join(userDir('DOCUMENTS', { ...host, homeDir }), 'Designs');

/** A full folder path in this platform's shape, for messages ("for example …"). */
export const exampleDesignsFolder = (platform: NodeJS.Platform = process.platform): string => {
  if (platform === 'win32') return 'C:\\Users\\you\\Designs';
  if (platform === 'darwin') return '/Users/you/Designs';
  return '/home/you/Designs';
};

export const isDirectory = async (target: string): Promise<boolean> => {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
};

const isFile = async (target: string): Promise<boolean> => {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
};

/**
 * A folder is a design (§6.1) when it holds design.json, the service's `.chamber/state.json`,
 * an artifact `index.html` or a `screens/` folder. Anything else under the root is the
 * user's own folder: never listed, reconciled, snapshotted or written into.
 */
export const isDesignFolder = async (dir: string): Promise<boolean> =>
  (await isFile(path.join(dir, DESIGN_JSON_FILE))) ||
  (await isFile(path.join(dir, '.chamber', 'state.json'))) ||
  (await isFile(path.join(dir, ENTRY_FILE))) ||
  (await isDirectory(path.join(dir, 'screens')));

/** How many design folders a root holds; 0 when unreadable/missing. */
export const countDesigns = async (root: string): Promise<number> => {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    let count = 0;
    for (const entry of entries) {
      if (entry.isDirectory() && isSlug(entry.name) && (await isDesignFolder(path.join(root, entry.name)))) count += 1;
    }
    return count;
  } catch {
    return 0;
  }
};

/** Where exports go: the setting, else the user's Downloads when it exists, else `<root>/.exports` (§4.3). */
export const resolveDownloadsDir = async (root: string, setting: string | undefined, homeDir: string = os.homedir(), host: RootHost = {}): Promise<string> => {
  if (typeof setting === 'string' && setting.trim() !== '') return setting;
  const downloads = userDir('DOWNLOAD', { ...host, homeDir });
  return (await isDirectory(downloads)) ? downloads : path.join(root, '.exports');
};

const expandHome = (raw: string, homeDir: string): string => {
  if (raw === '~') return homeDir;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(homeDir, raw.slice(2));
  return raw;
};

/** The home folders macOS privacy (TCC) guards per app, by their System Settings name. */
const DARWIN_PROTECTED = ['Documents', 'Downloads', 'Desktop'] as const;

/**
 * The protected home folder `folder` lies in on darwin (`Documents`…), else null: an EPERM
 * there usually means OpenChamber was not allowed into it, not that the user lacks rights.
 */
export const darwinProtectedFolder = (folder: string, homeDir: string): string | null => {
  for (const name of DARWIN_PROTECTED) {
    if (isInsideOrEqual(path.posix.join(homeDir, name), folder, path.posix, 'darwin')) return name;
  }
  return null;
};

export type FolderErrorHost = { platform?: NodeJS.Platform; homeDir?: string };

/**
 * Why a folder cannot be created or written, as a sentence (KI-5): the Node error code picks it;
 * the raw message (with Node syntax and the probe file name) is never shown. On macOS a denied
 * Documents/Downloads/Desktop says where to grant OpenChamber access.
 */
export const folderErrorSentence = (error: unknown, folder: string, host: FolderErrorHost = {}): string => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  switch (code) {
    case 'ENOENT':
      return `${folder} cannot be created: that drive or one of its parent folders does not exist.`;
    case 'EACCES':
    case 'EPERM': {
      const protectedName = (host.platform ?? process.platform) === 'darwin' ? darwinProtectedFolder(folder, host.homeDir ?? os.homedir()) : null;
      if (protectedName !== null) {
        return `macOS has not let OpenChamber use your ${protectedName} folder, so Design Chamber cannot open ${folder}. In System Settings → Privacy & Security → Files and Folders, turn on "${protectedName} Folder" for OpenChamber, then try again.`;
      }
      return `Design Chamber is not allowed to write to ${folder}. Pick a folder you own, for example in Documents.`;
    }
    case 'ENOTDIR':
    case 'EEXIST':
      return `Part of ${folder} is a file, not a folder. Pick another path.`;
    case 'EROFS':
      return `${folder} is on a read-only drive. Pick a folder on a drive you can write to.`;
    case 'ENOSPC':
    case 'EDQUOT':
      return `The drive holding ${folder} is full. Free some space or pick another drive.`;
    case 'EBUSY':
    case 'ETXTBSY':
      return `${folder} is in use by another program. Close it and try again.`;
    case 'ENAMETOOLONG':
      return 'That folder path is too long.';
    case 'EINVAL':
      return `${folder} is not a valid folder path.`;
    case 'ENODEV':
    case 'ENXIO':
    case 'EIO':
      return `The drive holding ${folder} cannot be reached. Check that it is connected and try again.`;
    default:
      return `Design Chamber cannot create or write to ${folder}. Pick another folder.`;
  }
};

export type RootValidation = { ok: true; root: string } | { ok: false; message: string };

export type ValidateRootOptions = {
  /** The extension package folder — a root inside it is refused (§7 PUT /settings). */
  packageRoot: string;
  homeDir?: string;
  /** Platform, env and file seams for the Documents folder and the message shapes. */
  host?: RootHost;
};

/**
 * Validate a user-chosen designs root. Order: invalid character (NUL) → not absolute (after
 * `~` expansion; a win32 drive-relative `C:foo` is not absolute) → filesystem root → inside
 * the extension package → not creatable/writable (mkdir -p, then a write+delete probe).
 */
export const validateRootCandidate = async (raw: unknown, options: ValidateRootOptions): Promise<RootValidation> => {
  const homeDir = options.homeDir ?? os.homedir();
  const host = options.host ?? {};
  const platform = host.platform ?? process.platform;
  if (typeof raw !== 'string') return { ok: false, message: 'The designs folder must be a path.' };
  const value = raw.trim();
  if (value.includes('\0')) return { ok: false, message: 'The folder path contains an invalid character.' };
  if (value.length > SETTINGS_PATH_MAX) return { ok: false, message: 'That folder path is too long.' };
  const expanded = expandHome(value, homeDir);
  if (expanded === '' || !path.isAbsolute(expanded)) {
    return { ok: false, message: `Choose a full folder path (for example ${exampleDesignsFolder(platform)}).` };
  }
  const abs = path.resolve(expanded);
  if (path.parse(abs).root === abs) {
    return { ok: false, message: 'A drive or filesystem root cannot hold your designs — pick a folder inside it.' };
  }
  // Every folder under the root is scanned and may become a design: the user's home (or a
  // folder holding it) and Documents itself (English or the XDG one) hold their own files.
  const documents = userDir('DOCUMENTS', { ...host, homeDir });
  if (isInsideOrEqual(abs, homeDir) || samePath(abs, path.join(homeDir, 'Documents')) || samePath(abs, documents)) {
    const example = platform === 'win32' ? 'Documents\\Designs' : 'Documents/Designs';
    return { ok: false, message: `That folder holds your own files, so it cannot be your designs folder. Pick or create a folder just for designs, for example ${example}.` };
  }
  if (isInsideOrEqual(options.packageRoot, abs)) {
    return { ok: false, message: 'That folder is inside the Design Chamber extension itself — pick a folder elsewhere.' };
  }
  try {
    await mkdir(abs, { recursive: true });
    const probe = path.join(abs, `.dc-write-probe-${process.pid}-${Math.random().toString(36).slice(2)}`);
    await writeFile(probe, '', 'utf8');
    await rm(probe, { force: true });
  } catch (error) {
    return { ok: false, message: folderErrorSentence(error, abs, { platform, homeDir }) };
  }
  return { ok: true, root: abs };
};

/** Case-insensitive on win32 and darwin, exact elsewhere — for comparing roots across settings reads. */
export const sameRoot = samePath;
