// The user's Documents/Downloads per platform (src/service/user-dirs.ts): Linux reads the XDG
// user-dirs file (translated installs), everything else uses the English names. The default
// designs root, the Downloads fallback and the "Documents itself" refusal follow it.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import type { Logger } from '../../../src/service/context.ts';
import { defaultDesignsRoot, resolveDownloadsDir, validateRootCandidate } from '../../../src/service/root.ts';
import { createSettingsStore } from '../../../src/service/settings.ts';
import { parseUserDirs, userDir } from '../../../src/service/user-dirs.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { REPO_ROOT } from './harness.ts';

const HOME = path.resolve('/home/you');
const GERMAN = [
  '# This file is written by xdg-user-dirs-update',
  'XDG_DESKTOP_DIR="$HOME/Schreibtisch"',
  'XDG_DOWNLOAD_DIR="$HOME/Downloads"',
  'XDG_DOCUMENTS_DIR="$HOME/Dokumente"',
  'XDG_MUSIC_DIR="$HOME"',
  '',
].join('\n');

const silentLog = (): Logger => ({ info() {}, warn() {}, error() {} });

describe('parseUserDirs', () => {
  test('$HOME paths, absolute paths and backslash escapes; $HOME itself means disabled', () => {
    const dirs = parseUserDirs(
      [
        'XDG_DOCUMENTS_DIR="$HOME/Mes Documents"',
        'XDG_DOWNLOAD_DIR="/data/T\\"ele\\$chargements"',
        'XDG_MUSIC_DIR="$HOME"',
        'XDG_VIDEOS_DIR="relative/ignored"',
        '  # XDG_PICTURES_DIR="$HOME/commented"',
        'garbage line',
      ].join('\r\n'),
      HOME,
    );
    assert.equal(dirs.DOCUMENTS, path.join(HOME, 'Mes Documents'));
    assert.equal(dirs.DOWNLOAD, path.resolve('/data/T"ele$chargements'));
    assert.equal(dirs.MUSIC, undefined, '$HOME alone = disabled');
    assert.equal(dirs.VIDEOS, undefined, 'a relative value is not a folder');
    assert.equal(dirs.PICTURES, undefined, 'a comment is not a setting');
  });
});

describe('userDir', () => {
  const files = (byPath: Record<string, string>) => (file: string) => byPath[file] ?? null;

  test('linux reads ${XDG_CONFIG_HOME:-~/.config}/user-dirs.dirs', () => {
    const atDefault = files({ [path.join(HOME, '.config', 'user-dirs.dirs')]: GERMAN });
    assert.equal(userDir('DOCUMENTS', { platform: 'linux', env: {}, homeDir: HOME, readText: atDefault }), path.join(HOME, 'Dokumente'));
    assert.equal(userDir('DOWNLOAD', { platform: 'linux', env: {}, homeDir: HOME, readText: atDefault }), path.join(HOME, 'Downloads'));
    const xdg = path.resolve('/cfg');
    const atXdg = files({ [path.join(xdg, 'user-dirs.dirs')]: GERMAN });
    assert.equal(userDir('DOCUMENTS', { platform: 'linux', env: { XDG_CONFIG_HOME: xdg }, homeDir: HOME, readText: atXdg }), path.join(HOME, 'Dokumente'));
    // A relative XDG_CONFIG_HOME is ignored (XDG base-dir spec): ~/.config is read instead.
    assert.equal(userDir('DOCUMENTS', { platform: 'linux', env: { XDG_CONFIG_HOME: 'cfg' }, homeDir: HOME, readText: atDefault }), path.join(HOME, 'Dokumente'));
  });

  test('linux falls back to ~/Documents and ~/Downloads when the file or the entry is missing', () => {
    assert.equal(userDir('DOCUMENTS', { platform: 'linux', env: {}, homeDir: HOME, readText: () => null }), path.join(HOME, 'Documents'));
    assert.equal(userDir('DOWNLOAD', { platform: 'linux', env: {}, homeDir: HOME, readText: () => 'XDG_DOCUMENTS_DIR="$HOME/Docs"' }), path.join(HOME, 'Downloads'));
    assert.equal(userDir('DOCUMENTS', { platform: 'linux', env: {}, homeDir: HOME, readText: () => 'XDG_DOCUMENTS_DIR="$HOME"' }), path.join(HOME, 'Documents'));
  });

  test('win32 and darwin never read the XDG file', () => {
    const reads: string[] = [];
    const spy = (file: string) => {
      reads.push(file);
      return GERMAN;
    };
    for (const platform of ['win32', 'darwin'] as const) {
      assert.equal(userDir('DOCUMENTS', { platform, env: {}, homeDir: HOME, readText: spy }), path.join(HOME, 'Documents'));
      assert.equal(userDir('DOWNLOAD', { platform, env: {}, homeDir: HOME, readText: spy }), path.join(HOME, 'Downloads'));
    }
    assert.deepEqual(reads, []);
  });
});

describe('the root rules follow the XDG Documents folder', () => {
  const writeUserDirs = async (home: string): Promise<void> => {
    await mkdir(path.join(home, '.config'), { recursive: true });
    await writeFile(path.join(home, '.config', 'user-dirs.dirs'), GERMAN, 'utf8');
  };

  test('default root = <Documents>/Designs; the settings store uses it', async (t) => {
    const tmp = await useTmpRoot(t);
    const home = tmp.at('home');
    await writeUserDirs(home);
    assert.equal(defaultDesignsRoot(home, { platform: 'linux', env: {} }), path.join(home, 'Dokumente', 'Designs'));
    assert.equal(defaultDesignsRoot(home, { platform: 'darwin', env: {} }), path.join(home, 'Documents', 'Designs'));
    const store = await createSettingsStore({
      log: silentLog(),
      packageRoot: REPO_ROOT,
      env: { DC_SETTINGS_PATH: tmp.at('settings.json') },
      platform: 'linux',
      homeDir: home,
    });
    assert.equal(store.defaultRoot(), path.join(home, 'Dokumente', 'Designs'));
    assert.equal(store.root(), path.join(home, 'Dokumente', 'Designs'));
  });

  test('exports default to the XDG Download folder when it exists', async (t) => {
    const tmp = await useTmpRoot(t);
    const home = tmp.at('home');
    await mkdir(path.join(home, '.config'), { recursive: true });
    await writeFile(path.join(home, '.config', 'user-dirs.dirs'), 'XDG_DOWNLOAD_DIR="$HOME/Téléchargements"\n', 'utf8');
    const host = { platform: 'linux' as const, env: {} };
    assert.equal(await resolveDownloadsDir(tmp.at('root'), undefined, home, host), path.join(tmp.at('root'), '.exports'), 'missing folder → .exports');
    await mkdir(path.join(home, 'Téléchargements'), { recursive: true });
    assert.equal(await resolveDownloadsDir(tmp.at('root'), undefined, home, host), path.join(home, 'Téléchargements'));
  });

  test('the translated Documents folder itself is refused as a root; a folder inside it is accepted', async (t) => {
    const tmp = await useTmpRoot(t);
    const home = tmp.at('home');
    await writeUserDirs(home);
    const check = (raw: string) => validateRootCandidate(raw, { packageRoot: REPO_ROOT, homeDir: home, host: { platform: 'linux', env: {} } });
    const refused = await check(path.join(home, 'Dokumente'));
    assert.equal(refused.ok, false);
    assert.match(refused.ok === false ? refused.message : '', /holds your own files/);
    assert.equal((await check(path.join(home, 'Dokumente', 'Designs'))).ok, true);
  });
});
