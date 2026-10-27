// Settings file and root switching (docs/SPEC.md §6.5, §9.2): the ported file contract,
// corrupt-file tolerance, validation refusals, and the rule that a root change NEVER moves
// files — the old root lands in previousRoots so the UI can offer "Switch back".

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ApiError } from '../../../src/service/http.ts';
import { PREVIOUS_ROOTS_MAX } from '../../../src/shared/limits.ts';
import {
  createSettingsStore,
  normalizeSettings,
  parseSettings,
  readSettingsFile,
  settingsFilePath,
  writeSettingsFile,
} from '../../../src/service/settings.ts';
import { countDesigns, defaultDesignsRoot, folderErrorSentence, resolveDownloadsDir, validateRootCandidate } from '../../../src/service/root.ts';
import type { Logger } from '../../../src/service/context.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { REPO_ROOT } from './harness.ts';

const silentLog = (): Logger => ({ info() {}, warn() {}, error() {} });

describe('settingsFilePath (§6.5)', () => {
  test('DC_SETTINGS_PATH wins on every platform', () => {
    const override = path.join(path.sep, 'tmp', 'dc', 'settings.json');
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      assert.equal(settingsFilePath({ DC_SETTINGS_PATH: override }, platform, path.join(path.sep, 'home')), path.resolve(override));
    }
  });

  test('per-platform defaults ("Design Chamber" / "design-chamber")', () => {
    const home = process.platform === 'win32' ? 'C:\\Users\\me' : '/home/me';
    assert.equal(settingsFilePath({ APPDATA: 'C:\\AppData' }, 'win32', home), path.join('C:\\AppData', 'Design Chamber', 'settings.json'));
    assert.equal(settingsFilePath({}, 'darwin', home), path.join(home, 'Library', 'Application Support', 'Design Chamber', 'settings.json'));
    assert.equal(settingsFilePath({ XDG_CONFIG_HOME: '/xdg' }, 'linux', home), path.join('/xdg', 'design-chamber', 'settings.json'));
    assert.equal(settingsFilePath({}, 'linux', home), path.join(home, '.config', 'design-chamber', 'settings.json'));
  });
});

describe('normalizeSettings / parseSettings', () => {
  test('garbage and wrong types read as absent', () => {
    for (const raw of [null, 42, 'x', [], { version: 9, root: 42, chromePath: {} }]) {
      assert.deepEqual(normalizeSettings(raw), { version: 1 });
    }
    assert.equal(parseSettings('{ not json'), null);
  });

  test('keeps valid fields and caps previousRoots at 10', () => {
    const roots = Array.from({ length: 14 }, (_unused, index) => `/old/${index}`);
    const normalized = normalizeSettings({ version: 1, root: '/data/designs', previousRoots: [...roots, 42], chromePath: 'C:\\chrome.exe', junk: true });
    assert.equal(normalized.root, '/data/designs');
    assert.equal(normalized.chromePath, 'C:\\chrome.exe');
    assert.equal(normalized.previousRoots?.length, PREVIOUS_ROOTS_MAX);
    assert.equal('junk' in normalized, false);
  });
});

describe('corrupt settings are tolerated (§6.5)', () => {
  test('a corrupt file reads as absent, logs once, and the store still works', async (t) => {
    const tmp = await useTmpRoot(t);
    const file = tmp.at('settings.json');
    await writeFile(file, '{{{ not json', 'utf8');
    const { settings, corrupt } = await readSettingsFile(file);
    assert.equal(corrupt, true);
    assert.deepEqual(settings, { version: 1 });

    const logs: string[] = [];
    const log: Logger = { info() {}, warn: (event) => void logs.push(event), error() {} };
    const store = await createSettingsStore({ log, packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: file }, homeDir: tmp.at('home') });
    assert.deepEqual(logs, ['settings.corrupt']);
    assert.deepEqual(store.read(), { version: 1 });
    assert.equal(store.root(), path.join(tmp.at('home'), 'Documents', 'Designs'));
    // And a later update overwrites the corrupt file with valid JSON.
    const designs = tmp.at('designs');
    await mkdir(designs, { recursive: true });
    await store.update({ root: designs });
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, root: designs, previousRoots: [store.defaultRoot()] });
  });

  test('a missing file is absent without noise', async (t) => {
    const tmp = await useTmpRoot(t);
    const { settings, corrupt } = await readSettingsFile(tmp.at('missing.json'));
    assert.equal(corrupt, false);
    assert.deepEqual(settings, { version: 1 });
  });

  test('writeSettingsFile writes normalised, parseable JSON atomically', async (t) => {
    const tmp = await useTmpRoot(t);
    const file = tmp.at('nested/settings.json');
    await writeSettingsFile(file, { version: 1, root: '/a', junk: 42 } as never);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { version: 1, root: '/a' });
  });
});

describe('validateRootCandidate (§7 PUT /settings refusals)', () => {
  const validate = (raw: unknown, packageRoot: string) => validateRootCandidate(raw, { packageRoot });

  test('a relative path is refused', async () => {
    const result = await validate('designs/here', REPO_ROOT);
    assert.equal(result.ok, false);
  });

  test('a filesystem root is refused', async () => {
    const drive = process.platform === 'win32' ? 'C:\\' : '/';
    assert.equal((await validate(drive, REPO_ROOT)).ok, false);
  });

  test('a folder inside the extension package is refused', async () => {
    assert.equal((await validate(path.join(REPO_ROOT, 'designs'), REPO_ROOT)).ok, false);
  });

  test('a NUL byte is refused', async () => {
    assert.equal((await validate(`${REPO_ROOT.slice(0, 3)}\0evil`, REPO_ROOT)).ok, false);
  });

  test('a path that cannot be created is refused', async (t) => {
    const tmp = await useTmpRoot(t);
    const aFile = tmp.at('afile');
    await writeFile(aFile, 'x', 'utf8');
    const result = await validate(path.join(aFile, 'child'), REPO_ROOT);
    assert.equal(result.ok, false);
    const message = result.ok === false ? result.message : '';
    assert.match(message, /is a file, not a folder/);
    assert.doesNotMatch(message, /ENOTDIR|EEXIST|mkdir|dc-write-probe/, 'no raw Node text (KI-5)');
  });

  test('a missing drive is refused with a sentence, not raw Node text', { skip: process.platform !== 'win32' }, async () => {
    const free = [...'ZYXWVUTSRQPONMLKJIHG'].find((letter) => !existsSync(`${letter}:\\`));
    if (!free) return;
    const result = await validate(`${free}:\\Designs`, REPO_ROOT);
    assert.equal(result.ok, false);
    const message = result.ok === false ? result.message : '';
    assert.match(message, /does not exist/);
    assert.doesNotMatch(message, /ENOENT|mkdir|\\\\\?/);
  });

  test('every common error code maps to a sentence without the raw message or probe name (KI-5)', () => {
    const folder = 'C:\\Windows';
    const raw = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: operation not permitted, open 'C:\\Windows\\.dc-write-probe-9956-abc'`), { code });
    const expected: Record<string, RegExp> = {
      ENOENT: /does not exist/,
      EACCES: /not allowed to write/,
      EPERM: /not allowed to write/,
      ENOTDIR: /is a file, not a folder/,
      EROFS: /read-only drive/,
      ENOSPC: /is full/,
      EBUSY: /in use/,
      ENAMETOOLONG: /too long/,
      EINVAL: /not a valid folder path/,
      EIO: /cannot be reached/,
      EWHATEVER: /cannot create or write/,
    };
    for (const [code, pattern] of Object.entries(expected)) {
      const sentence = folderErrorSentence(raw(code), folder);
      assert.match(sentence, pattern, code);
      assert.doesNotMatch(sentence, /dc-write-probe|operation not permitted|E[A-Z]{3,}/, code);
      assert.match(sentence, /\.$/, `${code} ends as a sentence`);
    }
    assert.match(folderErrorSentence('not an error', folder), /cannot create or write/);
  });

  test('macOS privacy: EPERM/EACCES under ~/Documents, ~/Downloads or ~/Desktop names the System Settings switch', () => {
    const denied = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: operation not permitted, scandir`), { code });
    const mac = { platform: 'darwin' as const, homeDir: '/Users/you' };
    for (const [folder, name] of [
      ['/Users/you/Documents/Designs', 'Documents'],
      ['/Users/you/Downloads', 'Downloads'],
      ['/users/you/desktop/designs', 'Desktop'], // re-cased: APFS is case-insensitive
    ] as const) {
      for (const code of ['EPERM', 'EACCES']) {
        const sentence = folderErrorSentence(denied(code), folder, mac);
        assert.match(sentence, /System Settings → Privacy & Security → Files and Folders/, `${code} ${folder}`);
        assert.ok(sentence.includes(`"${name} Folder"`), `${code} ${folder} names ${name}`);
        assert.ok(sentence.includes(folder));
        assert.doesNotMatch(sentence, /operation not permitted|E[A-Z]{3,}/);
      }
    }
    // Elsewhere on macOS, and the same folders on Linux, keep the ownership sentence.
    assert.match(folderErrorSentence(denied('EPERM'), '/Volumes/Shared/Designs', mac), /not allowed to write/);
    assert.match(folderErrorSentence(denied('EPERM'), '/Users/you/Documents/Designs', { platform: 'linux', homeDir: '/Users/you' }), /not allowed to write/);
    assert.match(folderErrorSentence(denied('ENOENT'), '/Users/you/Documents/Designs', mac), /does not exist/, 'only permission errors get the privacy sentence');
  });

  test('the "full folder path" example matches the platform', async () => {
    const relative = async (platform: NodeJS.Platform) => {
      const result = await validateRootCandidate('designs/here', { packageRoot: REPO_ROOT, host: { platform } });
      return result.ok === false ? result.message : '';
    };
    assert.match(await relative('win32'), /C:\\Users\\you\\Designs/);
    assert.match(await relative('darwin'), /\/Users\/you\/Designs/);
    assert.match(await relative('linux'), /\/home\/you\/Designs/);
  });

  test('a fresh folder under tmp is accepted and created', async (t) => {
    const tmp = await useTmpRoot(t);
    const target = tmp.at('brand-new/root');
    const result = await validate(target, REPO_ROOT);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.root, path.resolve(target));
  });

  test('non-string input is refused', async () => {
    assert.equal((await validate(42, REPO_ROOT)).ok, false);
  });

  test('the home folder, a folder above it and Documents itself are refused; a folder inside Documents is accepted', async (t) => {
    const tmp = await useTmpRoot(t);
    const homeDir = tmp.at('users/me');
    await mkdir(path.join(homeDir, 'Documents'), { recursive: true });
    const check = (raw: string) => validateRootCandidate(raw, { packageRoot: REPO_ROOT, homeDir });
    for (const refused of [homeDir, '~', tmp.at('users'), path.join(homeDir, 'Documents'), path.join(homeDir, 'documents')]) {
      if (refused.endsWith('documents') && process.platform !== 'win32') continue; // case-insensitive on win32 only
      const result = await check(refused);
      assert.equal(result.ok, false, refused);
      assert.match(result.ok === false ? result.message : '', /holds your own files/);
    }
    const inside = await check(path.join(homeDir, 'Documents', 'Designs'));
    assert.equal(inside.ok, true);
  });
});

describe('root changes never move files (§9.2)', () => {
  test('switching roots keeps every file, records previousRoots and notifies listeners', async (t) => {
    const tmp = await useTmpRoot(t);
    const rootA = tmp.at('root-a');
    const rootB = tmp.at('root-b');
    await mkdir(path.join(rootA, 'my-design', 'screens'), { recursive: true });
    await writeFile(path.join(rootA, 'my-design', 'design.json'), '{"version":1,"kind":"canvas","title":"Kept"}', 'utf8');
    await writeFile(path.join(rootA, 'my-design', 'screens', 'home.html'), '<h1>Kept</h1>', 'utf8');

    const settingsFile = tmp.at('settings.json');
    await writeFile(settingsFile, JSON.stringify({ version: 1, root: rootA }), 'utf8');
    const store = await createSettingsStore({ log: silentLog(), packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: settingsFile }, homeDir: tmp.at('home') });
    assert.equal(store.root(), path.resolve(rootA));

    const changes: [string, string][] = [];
    store.onRootChange((next, previous) => changes.push([next, previous]));

    await store.update({ root: rootB });
    assert.equal(store.root(), path.resolve(rootB));
    assert.deepEqual(changes, [[path.resolve(rootB), path.resolve(rootA)]]);

    // NOTHING moved: root A still holds the design, byte for byte; root B was created empty.
    assert.equal(await readFile(path.join(rootA, 'my-design', 'screens', 'home.html'), 'utf8'), '<h1>Kept</h1>');
    assert.equal(await countDesigns(rootA), 1);
    assert.equal(await countDesigns(rootB), 0);
    assert.deepEqual(store.read().previousRoots, [path.resolve(rootA)]);

    // The settings file on disk carries the switch.
    const onDisk = JSON.parse(await readFile(settingsFile, 'utf8')) as { root: string; previousRoots: string[] };
    assert.equal(onDisk.root, path.resolve(rootB));
    assert.deepEqual(onDisk.previousRoots, [path.resolve(rootA)]);

    // Switching back drops B into previousRoots (newest first) and A leaves the list.
    await store.update({ root: rootA });
    assert.deepEqual(store.read().previousRoots, [path.resolve(rootB)]);
    assert.equal(await countDesigns(rootA), 1);
  });

  test('previousRoots stays capped at 10 across many switches, newest first', async (t) => {
    const tmp = await useTmpRoot(t);
    const settingsFile = tmp.at('settings.json');
    const first = tmp.at('root-0');
    await mkdir(first, { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ version: 1, root: first }), 'utf8');
    const store = await createSettingsStore({ log: silentLog(), packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: settingsFile }, homeDir: tmp.at('home') });
    for (let index = 1; index <= 13; index += 1) {
      const next = tmp.at(`root-${index}`);
      await mkdir(next, { recursive: true });
      await store.update({ root: next });
    }
    const previous = store.read().previousRoots ?? [];
    assert.equal(previous.length, PREVIOUS_ROOTS_MAX);
    assert.equal(previous[0], path.resolve(tmp.at('root-12')));
    assert.equal(previous[1], path.resolve(tmp.at('root-11')));
  });

  test('root: null resets to the default without losing previousRoots', async (t) => {
    const tmp = await useTmpRoot(t);
    const homeDir = tmp.at('home');
    const settingsFile = tmp.at('settings.json');
    const rootA = tmp.at('root-a');
    await mkdir(rootA, { recursive: true });
    await writeFile(settingsFile, JSON.stringify({ version: 1, root: rootA }), 'utf8');
    const store = await createSettingsStore({ log: silentLog(), packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: settingsFile }, homeDir });
    await store.update({ root: null });
    assert.equal(store.root(), defaultDesignsRoot(homeDir));
    assert.deepEqual(store.read().previousRoots, [path.resolve(rootA)]);
  });

  test('an invalid new root throws bad-path and changes nothing', async (t) => {
    const tmp = await useTmpRoot(t);
    const rootA = tmp.at('root-a');
    await mkdir(rootA, { recursive: true });
    const settingsFile = tmp.at('settings.json');
    await writeFile(settingsFile, JSON.stringify({ version: 1, root: rootA }), 'utf8');
    const store = await createSettingsStore({ log: silentLog(), packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: settingsFile }, homeDir: tmp.at('home') });
    await assert.rejects(
      store.update({ root: 'relative/nope' }),
      (error: unknown) => error instanceof ApiError && error.code === 'bad-path',
    );
    assert.equal(store.root(), path.resolve(rootA));
    assert.equal(store.read().previousRoots, undefined);
    // The file on disk was not touched.
    assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { version: 1, root: rootA });
  });

  test('chromePath is stored, cleared with null, and validated', async (t) => {
    const tmp = await useTmpRoot(t);
    const settingsFile = tmp.at('settings.json');
    const store = await createSettingsStore({ log: silentLog(), packageRoot: REPO_ROOT, env: { DC_SETTINGS_PATH: settingsFile }, homeDir: tmp.at('home') });
    const chrome = process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome';
    await store.update({ chromePath: chrome });
    assert.equal(store.read().chromePath, chrome);
    await assert.rejects(
      store.update({ chromePath: '   ' }),
      (error: unknown) => error instanceof ApiError && error.code === 'bad-path',
    );
    await store.update({ chromePath: null });
    assert.equal(store.read().chromePath, undefined);
  });
});

describe('root helpers', () => {
  test('countDesigns counts slug folders that are designs only and answers 0 for a missing root', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('designs/good-one/design.json', '{}');
    await tmp.write('designs/notes/todo.txt', 'not a design');
    await mkdir(tmp.at('designs/empty-folder'), { recursive: true });
    await mkdir(tmp.at('designs/.trash/old'), { recursive: true });
    await mkdir(tmp.at('designs/Not A Slug'), { recursive: true });
    await tmp.write('designs/a-file.txt', 'x');
    assert.equal(await countDesigns(tmp.at('designs')), 1);
    assert.equal(await countDesigns(tmp.at('missing')), 0);
  });

  test('resolveDownloadsDir prefers the setting, then ~/Downloads, then <root>/.exports', async (t) => {
    const tmp = await useTmpRoot(t);
    const homeDir = tmp.at('home');
    assert.equal(await resolveDownloadsDir(tmp.at('root'), '/custom/dir', homeDir), '/custom/dir');
    await mkdir(path.join(homeDir, 'Downloads'), { recursive: true });
    assert.equal(await resolveDownloadsDir(tmp.at('root'), undefined, homeDir), path.join(homeDir, 'Downloads'));
    assert.equal(await resolveDownloadsDir(tmp.at('root'), undefined, tmp.at('empty-home')), path.join(tmp.at('root'), '.exports'));
  });
});
