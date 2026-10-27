import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test, type TestContext } from 'node:test';

import { createFakeContext } from '../../helpers/fake-context.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';
import { createRevealRegistry, createRevealService, linuxOpenerEnv, revealPlan } from '../../../src/service/reveal.ts';
import { ApiError } from '../../../src/service/http.ts';
import { artifactDesign } from './harness.ts';

type SpawnCall = { command: string; args: string[] };

/** `succeeds(command)` decides each fake launch; every launch is recorded with the env it got. */
const setup = async (
  t: TestContext,
  platform: NodeJS.Platform = 'win32',
  options: { succeeds?: (command: string) => boolean; env?: NodeJS.ProcessEnv } = {},
) => {
  const tmp = await useTmpRoot(t);
  await tmp.writeDesign('art', artifactDesign());
  const ctx = createFakeContext({ root: tmp.root });
  t.after(() => ctx.dispose());
  const spawns: SpawnCall[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const registry = createRevealRegistry(platform);
  const reveal = createRevealService({
    store: ctx.store,
    log: ctx.log,
    registry,
    platform,
    ...(options.env ? { env: options.env } : {}),
    launch: async ({ command, args }, env) => {
      spawns.push({ command, args });
      envs.push(env);
      return options.succeeds ? options.succeeds(command) : true;
    },
  });
  return { tmp, registry, reveal, spawns, envs };
};

describe('reveal', () => {
  test('refuses every path it did not issue and that is not a design folder', async (t) => {
    const { tmp, reveal } = await setup(t);
    for (const foreign of [
      tmp.at('art/index.html'), // inside a design, but not the folder itself
      path.join(tmp.root, 'nope.zip'),
      process.platform === 'win32' ? 'C:\\Windows\\system32' : '/etc',
      '',
      'relative/path.zip',
    ]) {
      await assert.rejects(reveal.reveal(foreign), (error: unknown) => error instanceof ApiError && error.code === 'bad-path', `refused: ${foreign}`);
    }
    await assert.rejects(reveal.reveal(123 as unknown as string), ApiError);
    await assert.rejects(reveal.reveal('C:\\ok\u0000evil.zip'), ApiError);
  });

  test('accepts an issued export path and spawns the platform file manager on it', async (t) => {
    const { tmp, registry, reveal, spawns } = await setup(t, 'win32');
    const issued = path.join(tmp.root, 'art.zip');
    await tmp.write('art.zip', 'x'); // must exist to be revealed
    registry.issue(issued);
    await reveal.reveal(issued);
    assert.deepEqual(spawns, [{ command: 'explorer.exe', args: [`/select,${issued}`] }]);

    // Case differences are the same path on Windows (the file must exist under that spelling,
    // which only a case-insensitive disk — Windows, default macOS — can show).
    if (process.platform !== 'linux') {
      spawns.length = 0;
      await reveal.reveal(issued.toUpperCase());
      assert.equal(spawns.length, 1);
    }
  });

  test('darwin uses open -R, linux opens the containing folder', async (t) => {
    const { tmp, registry, reveal, spawns } = await setup(t, 'darwin');
    const issued = path.join(tmp.root, 'art.zip');
    await tmp.write('art.zip', 'x');
    registry.issue(issued);
    await reveal.reveal(issued);
    assert.deepEqual(spawns, [{ command: 'open', args: ['-R', issued] }]);

    const linux = await setup(t, 'linux');
    const linuxPath = path.join(linux.tmp.root, 'art.zip');
    await linux.tmp.write('art.zip', 'x');
    linux.registry.issue(linuxPath);
    await linux.reveal.reveal(linuxPath);
    assert.deepEqual(linux.spawns, [{ command: 'xdg-open', args: [linux.tmp.root] }]);
  });

  test('linux falls back xdg-open → gio open → FileManager1.ShowItems, stopping at the first that works', async (t) => {
    const linux = await setup(t, 'linux', { succeeds: (command) => command === 'gdbus' });
    const issued = path.join(linux.tmp.root, 'art.zip');
    await linux.tmp.write('art.zip', 'x');
    linux.registry.issue(issued);
    await linux.reveal.reveal(issued);
    assert.deepEqual(linux.spawns.map((call) => call.command), ['xdg-open', 'gio', 'gdbus']);
    assert.deepEqual(linux.spawns[1]?.args, ['open', linux.tmp.root]);
    const showItems = linux.spawns[2]?.args ?? [];
    assert.ok(showItems.includes('org.freedesktop.FileManager1.ShowItems'));
    assert.match(showItems.at(-2) ?? '', /^\['file:\/\/.*art\.zip'\]$/);

    const second = await setup(t, 'linux', { succeeds: (command) => command === 'gio' });
    const other = path.join(second.tmp.root, 'art.zip');
    await second.tmp.write('art.zip', 'x');
    second.registry.issue(other);
    await second.reveal.reveal(other);
    assert.deepEqual(second.spawns.map((call) => call.command), ['xdg-open', 'gio'], 'ShowItems is not tried once gio worked');
  });

  test('linux with no working file manager answers a sentence naming the file, not a spawn error', async (t) => {
    const linux = await setup(t, 'linux', { succeeds: () => false });
    const issued = path.join(linux.tmp.root, 'art.zip');
    await linux.tmp.write('art.zip', 'x');
    linux.registry.issue(issued);
    await assert.rejects(linux.reveal.reveal(issued), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.match(error.message, /could not open a file manager/);
      assert.ok(error.message.includes(issued), 'the path is in the message so the user can open it');
      assert.doesNotMatch(error.message, /ENOENT|spawn/);
      return true;
    });
    assert.equal(linux.spawns.length, 3);
  });

  test('the ShowItems URI cannot break out of its D-Bus string literal', () => {
    const plan = revealPlan("/home/you/Downloads/it's ] , ['x'].zip", 'linux');
    const literal = plan[2]?.args.at(-2) ?? '';
    assert.equal(literal.split("'").length, 3, `exactly one quoted string: ${literal}`);
    assert.match(literal, /it%27s/);
    // Every step is an argv array: the path is one argument, never a shell string.
    assert.deepEqual(plan[0], { command: 'xdg-open', args: ['/home/you/Downloads'], wait: true });
  });

  test('linux openers get the session bus and Wayland socket derived from XDG_RUNTIME_DIR (the host env lacks them, F9)', async (t) => {
    const present = new Set(['/run/user/1000/bus', '/run/user/1000/wayland-0']);
    const derived = linuxOpenerEnv({ PATH: '/usr/bin', XDG_RUNTIME_DIR: '/run/user/1000' }, (file) => present.has(file));
    assert.equal(derived.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
    assert.equal(derived.WAYLAND_DISPLAY, 'wayland-0');
    assert.equal(derived.DISPLAY, undefined, 'no X11 display is guessed');
    // Values already present are kept; no runtime dir → nothing added.
    assert.equal(linuxOpenerEnv({ XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' }, () => true).DBUS_SESSION_BUS_ADDRESS, 'unix:path=/x');
    assert.deepEqual(linuxOpenerEnv({ PATH: '/usr/bin' }, () => true), { PATH: '/usr/bin' });

    // darwin and win32 launches get the env unchanged.
    const mac = await setup(t, 'darwin', { env: { XDG_RUNTIME_DIR: '/run/user/1000' } });
    await mac.reveal.reveal(mac.tmp.at('art'));
    assert.equal(mac.envs[0]?.DBUS_SESSION_BUS_ADDRESS, undefined);
  });

  test('darwin compares paths case-insensitively (APFS default), linux exactly', async () => {
    const mac = createRevealRegistry('darwin');
    mac.issue('/Users/you/Downloads/art.zip');
    assert.equal(mac.has('/users/YOU/downloads/ART.zip'), true);
    const linux = createRevealRegistry('linux');
    linux.issue('/home/you/Downloads/art.zip');
    assert.equal(linux.has('/home/you/downloads/art.zip'), false);
  });

  test('accepts a design folder path', async (t) => {
    const { tmp, reveal, spawns } = await setup(t);
    await reveal.reveal(tmp.at('art'));
    assert.equal(spawns.length, 1);
    assert.ok(spawns[0]?.args[0]?.startsWith('/select,'));
  });

  test('an issued path that vanished is 404, not a spawn', async (t) => {
    const { tmp, registry, reveal, spawns } = await setup(t);
    const gone = path.join(tmp.root, 'gone.zip');
    registry.issue(gone);
    await assert.rejects(reveal.reveal(gone), (error: unknown) => error instanceof ApiError && error.code === 'not-found');
    assert.equal(spawns.length, 0);
  });

  test('mayReveal answers without spawning', async (t) => {
    const { tmp, registry, reveal, spawns } = await setup(t);
    const issued = path.join(tmp.root, 'art.zip');
    await tmp.write('art.zip', 'x');
    registry.issue(issued);
    assert.equal(await reveal.mayReveal(issued), true);
    assert.equal(await reveal.mayReveal(path.join(tmp.root, 'other.zip')), false);
    assert.equal(spawns.length, 0);
  });

  test('the registry forgets the oldest path past its bound', async (t) => {
    const registry = createRevealRegistry('win32');
    registry.issue('C:\\first\\a.zip');
    for (let i = 0; i < 1200; i += 1) registry.issue(`C:\\bulk\\f${i}.zip`);
    assert.equal(registry.has('C:\\first\\a.zip'), false);
    assert.equal(registry.has('C:\\bulk\\f1199.zip'), true);
  });
});
