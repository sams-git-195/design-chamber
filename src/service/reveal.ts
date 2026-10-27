// "Show in folder" (docs/SPEC.md §4.3, §9.5): opens the OS file manager on a path the service
// itself issued this run (an export) or on a design folder — never anywhere else. Every
// command is spawned with an args array (no shell), so no path is ever interpolated.
//
//   win32   explorer.exe /select,<path>   fire-and-forget: explorer exits non-zero even on success
//   darwin  open -R <path>                fire-and-forget
//   linux   xdg-open <dir> → gio open <dir> → FileManager1.ShowItems over D-Bus (gdbus), the
//           next one tried only when the previous could not start or exited non-zero.
//
// The service env is an allowlist (F9: no DISPLAY, WAYLAND_DISPLAY or DBUS_SESSION_BUS_ADDRESS),
// so on Linux the session bus and Wayland socket are re-derived from XDG_RUNTIME_DIR, which is
// passed — that is how the desktop's file manager is reached from a headless child process.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PROJECT_DIRECTORY_MAX } from '../shared/limits.ts';
import { ApiError } from './http.ts';
import type { DesignStore, Logger } from './context.ts';
import { foldsCase } from './paths.ts';

/** Paths the service wrote this run. Bounded: the oldest issued path is forgotten first. */
export type RevealRegistry = {
  issue(absolutePath: string): void;
  has(absolutePath: string): boolean;
};

const REGISTRY_MAX = 1000;
/** How long a Linux opener may run before it is taken as launched (some stay open with the window). */
const LINUX_OPENER_WAIT_MS = 5000;

/** Comparison form: absolute, separators normalised, case-folded where the filesystem is (win32, darwin). */
const normalizePathKey = (value: string, platform: NodeJS.Platform): string => {
  const resolved = path.resolve(value);
  return foldsCase(platform === 'win32' ? path.win32 : path.posix, platform) ? resolved.toLowerCase() : resolved;
};

export const createRevealRegistry = (platform: NodeJS.Platform = process.platform): RevealRegistry => {
  const issued = new Set<string>();
  return {
    issue(absolutePath: string): void {
      const key = normalizePathKey(absolutePath, platform);
      issued.add(key);
      if (issued.size > REGISTRY_MAX) {
        const oldest = issued.values().next();
        if (!oldest.done) issued.delete(oldest.value);
      }
    },
    has: (absolutePath: string) => issued.has(normalizePathKey(absolutePath, platform)),
  };
};

/** One command in a reveal plan. `wait`: the outcome decides whether the next command runs. */
export type RevealCommand = { command: string; args: string[]; wait: boolean };

/**
 * Starts `command`. With `wait`, resolves true once it exited 0 (or is still running after
 * the grace period — it launched), false when it could not start or exited non-zero.
 * Without `wait`, resolves true at once.
 */
export type LaunchFn = (step: RevealCommand, env: NodeJS.ProcessEnv) => Promise<boolean>;

const defaultLaunch: LaunchFn = (step, env) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const child = spawn(step.command, step.args, { detached: true, stdio: 'ignore', env });
    child.on('error', () => finish(false)); // ENOENT: this opener is not installed
    child.unref();
    if (!step.wait) {
      finish(true);
      return;
    }
    child.on('exit', (code) => finish(code === 0));
    setTimeout(() => finish(true), LINUX_OPENER_WAIT_MS).unref();
  });

/** A D-Bus string-array literal holding one file URI; `'` is percent-encoded so the literal cannot be broken. */
const showItemsArg = (target: string): string => `['${pathToFileURL(target).href.replace(/'/g, '%27')}']`;

/** The commands to try, in order, for one resolved path. */
export const revealPlan = (resolved: string, platform: NodeJS.Platform): RevealCommand[] => {
  if (platform === 'win32') return [{ command: 'explorer.exe', args: [`/select,${resolved}`], wait: false }];
  if (platform === 'darwin') return [{ command: 'open', args: ['-R', resolved], wait: false }];
  const dir = path.dirname(resolved);
  return [
    { command: 'xdg-open', args: [dir], wait: true },
    { command: 'gio', args: ['open', dir], wait: true },
    {
      command: 'gdbus',
      args: [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.FileManager1',
        '--object-path',
        '/org/freedesktop/FileManager1',
        '--method',
        'org.freedesktop.FileManager1.ShowItems',
        showItemsArg(resolved),
        '',
      ],
      wait: true,
    },
  ];
};

/**
 * The env a Linux opener needs to reach the user's desktop: the allowlisted service env plus
 * the session bus (`$XDG_RUNTIME_DIR/bus`) and the Wayland socket (`wayland-0`) when they exist
 * and the variables are not already set. Nothing is guessed for X11 (no DISPLAY): the X
 * authority file is not passed either, so a guessed display would not authenticate.
 */
export const linuxOpenerEnv = (env: NodeJS.ProcessEnv, exists: (file: string) => boolean = existsSync): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...env };
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (typeof runtimeDir !== 'string' || !path.posix.isAbsolute(runtimeDir)) return next;
  const bus = path.posix.join(runtimeDir, 'bus');
  if (!next.DBUS_SESSION_BUS_ADDRESS && exists(bus)) next.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  if (!next.WAYLAND_DISPLAY && exists(path.posix.join(runtimeDir, 'wayland-0'))) next.WAYLAND_DISPLAY = 'wayland-0';
  return next;
};

export type RevealDeps = {
  store: DesignStore;
  log: Logger;
  registry: RevealRegistry;
  /** Injectable for tests. */
  launch?: LaunchFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
};

export type RevealService = {
  /** Throws `bad-path` for anything the service did not issue and that is not a design folder. */
  reveal(requested: string): Promise<void>;
  /** True when the path may be revealed (export issued this run, or a design folder). */
  mayReveal(requested: string): Promise<boolean>;
};

export const createRevealService = (deps: RevealDeps): RevealService => {
  const platform = deps.platform ?? process.platform;
  const launch = deps.launch ?? defaultLaunch;

  const isDesignFolder = async (normalized: string): Promise<boolean> => {
    const designs = await deps.store.list().catch(() => []);
    for (const design of designs) {
      const dir = await deps.store.dir(design.slug).catch(() => null);
      if (dir !== null && normalizePathKey(dir, platform) === normalized) return true;
    }
    return false;
  };

  const check = async (requested: unknown): Promise<string> => {
    if (typeof requested !== 'string' || requested.trim() === '' || requested.length > PROJECT_DIRECTORY_MAX) {
      throw new ApiError('bad-path', 'That is not a path Design Chamber can open.');
    }
    if (requested.includes('\u0000')) throw new ApiError('bad-path', 'That is not a path Design Chamber can open.');
    const resolved = path.resolve(requested);
    const normalized = normalizePathKey(resolved, platform);
    if (deps.registry.has(normalized) || (await isDesignFolder(normalized))) return resolved;
    throw new ApiError('bad-path', 'Design Chamber only opens the folders and export files it created itself.');
  };

  return {
    async mayReveal(requested: string): Promise<boolean> {
      try {
        await check(requested);
        return true;
      } catch {
        return false;
      }
    },
    async reveal(requested: string): Promise<void> {
      const resolved = await check(requested);
      if (!existsSync(resolved)) throw new ApiError('not-found', 'That file does not exist any more.');
      const baseEnv = deps.env ?? process.env;
      const env = platform === 'win32' || platform === 'darwin' ? baseEnv : linuxOpenerEnv(baseEnv);
      const tried: string[] = [];
      for (const step of revealPlan(resolved, platform)) {
        tried.push(step.command);
        if (await launch(step, env)) return;
      }
      deps.log.warn('reveal.no-file-manager', { tried: tried.join(', ') });
      throw new ApiError(
        'internal',
        `Design Chamber could not open a file manager. The file is at ${resolved} — open it yourself, or install xdg-utils so "Show in folder" works.`,
      );
    },
  };
};
