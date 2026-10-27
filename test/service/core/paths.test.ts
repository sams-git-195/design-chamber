// The one containment function (docs/SPEC.md §9.1) — the risk surface every service path
// goes through. The win32 rules are tested on any platform by injecting `path.win32` /
// `path.posix` and a fake realpath (SPEC §15.1); a real junction/symlink escape is tested
// against the actual filesystem when the platform allows creating one.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath as fsRealpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { ApiError } from '../../../src/service/http.ts';
import { foldsCase, isInsideOrEqual, isStrictlyInside, resolveInside, samePath, writeFileAtomic, type ContainmentDeps } from '../../../src/service/paths.ts';

/** A realpath that answers exactly the mapped paths and ENOENTs everything else. */
const fakeRealpath = (existing: Record<string, string>): ContainmentDeps['realpath'] => {
  return async (target: string) => {
    const mapped = existing[target];
    if (mapped !== undefined) return mapped;
    throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${target}'`), { code: 'ENOENT' });
  };
};

const win32Deps = (existing: Record<string, string>): ContainmentDeps => ({ path: path.win32, realpath: fakeRealpath(existing) });
// Linux rules: case-sensitive. (On a darwin host the default platform would fold case.)
const posixDeps = (existing: Record<string, string>): ContainmentDeps => ({ path: path.posix, realpath: fakeRealpath(existing), platform: 'linux' });
const darwinDeps = (existing: Record<string, string>): ContainmentDeps => ({ path: path.posix, realpath: fakeRealpath(existing), platform: 'darwin' });

const rejectsBadPath = async (promise: Promise<string>, label: string): Promise<void> => {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === 'bad-path',
    `expected bad-path for ${label}`,
  );
};

describe('resolveInside — lexical refusals (both path flavours)', () => {
  const WIN_ROOT = 'C:\\Designs';
  const win = win32Deps({ [WIN_ROOT]: WIN_ROOT });
  const POSIX_ROOT = '/data/designs';
  const posix = posixDeps({ [POSIX_ROOT]: POSIX_ROOT });

  const win32Cases: [string, string[]][] = [
    ['dot-dot', ['..']],
    ['dot-dot walk', ['home', '..', '..']],
    ['dot-dot prefix', ['..\\secret.txt']],
    ['dot-dot inside one segment', ['a\\..\\b']],
    ['absolute path', ['C:\\Windows\\system32']],
    ['other drive', ['D:\\data']],
    ['drive-relative', ['C:evil']],
    ['UNC server', ['\\\\server\\share']],
    ['UNC forward slashes', ['//server/share']],
    ['NUL byte', ['a\0b']],
    ['empty segment', ['']],
  ];
  for (const [label, segments] of win32Cases) {
    test(`win32 refuses ${label}`, async () => {
      await rejectsBadPath(resolveInside(WIN_ROOT, segments, win), `win32 ${label}`);
    });
  }

  const posixCases: [string, string[]][] = [
    ['dot-dot', ['..']],
    ['dot-dot walk', ['../etc/passwd']],
    ['dot-dot inside one segment (win32 spelling)', ['a\\..\\b']],
    ['absolute path', ['/etc/passwd']],
    ['drive letter (win32 trick)', ['C:\\Windows']],
    ['drive-relative (win32 trick)', ['C:evil']],
    ['UNC backslash (win32 trick)', ['\\\\server\\share']],
    ['UNC forward slashes', ['//server/share']],
    ['NUL byte', ['a\0b']],
    ['empty segment', ['']],
  ];
  for (const [label, segments] of posixCases) {
    test(`posix refuses ${label}`, async () => {
      await rejectsBadPath(resolveInside(POSIX_ROOT, segments, posix), `posix ${label}`);
    });
  }

  test('a NUL in the root itself is refused', async () => {
    await rejectsBadPath(resolveInside('C:\\Des\0igns', ['a'], win), 'NUL root');
  });

  test('an empty root is refused', async () => {
    await rejectsBadPath(resolveInside('   ', ['a'], win), 'blank root');
  });

  test('a root that does not exist is refused with a user-facing sentence', async () => {
    await assert.rejects(
      resolveInside('C:\\Nope', ['a'], win32Deps({})),
      (error: unknown) => error instanceof ApiError && error.code === 'bad-path' && /does not exist/.test(error.message),
    );
  });
});

describe('resolveInside — accepted paths', () => {
  test('win32 resolves nested segments, including files that do not exist yet', async () => {
    const deps = win32Deps({ 'C:\\Designs': 'C:\\Designs' });
    assert.equal(await resolveInside('C:\\Designs', ['home', 'screens\\a.html'], deps), 'C:\\Designs\\home\\screens\\a.html');
  });

  test('posix resolves nested segments', async () => {
    const deps = posixDeps({ '/data/designs': '/data/designs' });
    assert.equal(await resolveInside('/data/designs', ['home', 'screens/a.html'], deps), '/data/designs/home/screens/a.html');
  });

  test('the root itself resolves to the root (relative "")', async () => {
    const deps = win32Deps({ 'C:\\Designs': 'C:\\Designs' });
    assert.equal(await resolveInside('C:\\Designs', ['.'], deps), 'C:\\Designs');
  });

  test('win32 containment is case-insensitive — an odd-case realpath stays inside', async () => {
    const deps = win32Deps({
      'c:\\DESIGNS': 'C:\\Designs',
      'c:\\DESIGNS\\home': 'C:\\designs\\HOME',
    });
    // The user typed the root in one case, the disk answers in another; the target is a
    // file that does not exist yet under a differently-cased real folder.
    assert.equal(await resolveInside('c:\\DESIGNS', ['home', 'x.html'], deps), 'C:\\designs\\HOME\\x.html');
  });

  test('posix containment is case-sensitive — a case-flipped symlink target escapes', async () => {
    const deps = posixDeps({ '/data/Designs': '/data/Designs', '/data/Designs/link': '/data/designs-other' });
    await rejectsBadPath(resolveInside('/data/Designs', ['link', 'f.html'], deps), 'posix case-sensitive escape');
  });

  test('the same case-flipped target stays inside when comparison is case-insensitive', async () => {
    const deps: ContainmentDeps = {
      path: path.posix,
      realpath: fakeRealpath({ '/data/designs': '/data/designs', '/data/designs/link': '/data/DESIGNS/real' }),
      caseInsensitive: true,
    };
    assert.equal(await resolveInside('/data/designs', ['link', 'f.html'], deps), '/data/DESIGNS/real/f.html');
  });
});

describe('resolveInside — symlink/junction escapes', () => {
  test('a fake junction pointing at another drive is refused (win32)', async () => {
    const deps = win32Deps({ 'C:\\Designs': 'C:\\Designs', 'C:\\Designs\\junction': 'D:\\Elsewhere' });
    await rejectsBadPath(resolveInside('C:\\Designs', ['junction', 'secret.txt'], deps), 'junction to D:');
    await rejectsBadPath(resolveInside('C:\\Designs', ['junction'], deps), 'junction itself');
  });

  test('a fake symlink pointing outside the root is refused (posix)', async () => {
    const deps = posixDeps({ '/data/designs': '/data/designs', '/data/designs/escape': '/outside' });
    await rejectsBadPath(resolveInside('/data/designs', ['escape', 'f.html'], deps), 'symlink out');
  });

  test('a symlink that stays inside the root is accepted', async () => {
    const deps = posixDeps({ '/data/designs': '/data/designs', '/data/designs/link': '/data/designs/real' });
    assert.equal(await resolveInside('/data/designs', ['link', 'f.html'], deps), '/data/designs/real/f.html');
  });

  test('a REAL junction/symlink escape is refused by the real filesystem', async (t) => {
    const tmp = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), 'dc-containment-')));
    t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const root = path.join(tmp, 'root');
    const outside = path.join(tmp, 'outside');
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, 'secret.txt'), 'top secret', 'utf8');
    const link = path.join(root, 'link');
    try {
      // Junctions need no elevation on win32; plain dir symlinks elsewhere.
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.skip(`symlinks unavailable on this platform/account: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    await rejectsBadPath(resolveInside(root, ['link', 'secret.txt']), 'real junction escape');
    // A plain nested path still resolves (and the answer is the realpath'd target).
    const nested = await resolveInside(root, ['design', 'index.html']);
    assert.equal(nested, path.join(root, 'design', 'index.html'));
  });
});

describe('samePath / isInsideOrEqual', () => {
  test('samePath is case-insensitive for the win32 flavour and exact for posix', () => {
    assert.equal(samePath('C:\\Designs', 'c:\\designs\\', path.win32), true);
    assert.equal(samePath('C:\\Designs', 'C:\\Designs2', path.win32), false);
    assert.equal(samePath('/data/Designs', '/data/designs', path.posix, 'linux'), false);
    assert.equal(samePath('/data/Designs', '/data/Designs/', path.posix), true);
  });

  test('isInsideOrEqual covers the root itself and descendants, refuses escapes', () => {
    assert.equal(isInsideOrEqual('C:\\Designs', 'C:\\Designs', path.win32), true);
    assert.equal(isInsideOrEqual('C:\\Designs', 'c:\\designs\\slug\\index.html', path.win32), true);
    assert.equal(isInsideOrEqual('C:\\Designs', 'C:\\DesignsEvil', path.win32), false);
    assert.equal(isInsideOrEqual('C:\\Designs', 'C:\\Windows', path.win32), false);
    assert.equal(isInsideOrEqual('/data/designs', '/data/designs/slug', path.posix), true);
    assert.equal(isInsideOrEqual('/data/designs', '/data/other', path.posix), false);
  });

  test('isStrictlyInside (the bundler classifier) excludes the root itself and every escape', () => {
    assert.equal(isStrictlyInside('C:\\Designs\\art', 'C:\\Designs\\art', path.win32), false);
    assert.equal(isStrictlyInside('C:\\Designs\\art', 'c:\\designs\\ART\\assets\\x.png', path.win32), true);
    assert.equal(isStrictlyInside('C:\\Designs\\art', 'C:\\Designs\\art\\..foo', path.win32), true, 'a name starting with ".." is not a step up');
    assert.equal(isStrictlyInside('C:\\Designs\\art', 'C:\\Designs\\artwork\\x.png', path.win32), false);
    assert.equal(isStrictlyInside('C:\\Designs\\art', 'D:\\Designs\\art\\x.png', path.win32), false);
    assert.equal(isStrictlyInside('C:\\Designs\\art', '\\\\server\\share\\x.png', path.win32), false);
    assert.equal(isStrictlyInside('/data/art', '/data/art/x.png', path.posix), true);
    assert.equal(isStrictlyInside('/data/art', '/data/Art/x.png', path.posix, 'linux'), false);
    assert.equal(isStrictlyInside('/data/art', '/data/art/../x.png', path.posix), false);
  });
});

describe('darwin is case-insensitive (default APFS), linux exact', () => {
  test('foldsCase: the win32 flavour always, darwin always, linux never', () => {
    assert.equal(foldsCase(path.win32, 'linux'), true);
    assert.equal(foldsCase(path.posix, 'darwin'), true);
    assert.equal(foldsCase(path.posix, 'linux'), false);
  });

  test('a re-cased home is still the home on darwin (the "holds your own files" refusal cannot be dodged)', () => {
    assert.equal(samePath('/Users/you/Documents', '/users/YOU/documents', path.posix, 'darwin'), true);
    assert.equal(isInsideOrEqual('/Users/you', '/users/you/Designs', path.posix, 'darwin'), true);
    assert.equal(isInsideOrEqual('/Users/you', '/users/you/Designs', path.posix, 'linux'), false);
    assert.equal(isStrictlyInside('/Users/you/Designs/art', '/Users/you/designs/ART/x.png', path.posix, 'darwin'), true);
    assert.equal(isStrictlyInside('/Users/you/Designs/art', '/Users/you/Designs/artwork/x.png', path.posix, 'darwin'), false);
  });

  test('resolveInside on darwin: a differently-cased realpath stays inside; a real escape is still refused', async () => {
    const deps = darwinDeps({ '/Users/you/Designs': '/Users/you/Designs', '/Users/you/Designs/link': '/Users/you/designs/real' });
    assert.equal(await resolveInside('/Users/you/Designs', ['link', 'f.html'], deps), '/Users/you/designs/real/f.html');
    const escape = darwinDeps({ '/Users/you/Designs': '/Users/you/Designs', '/Users/you/Designs/link': '/Users/you/Desktop' });
    await rejectsBadPath(resolveInside('/Users/you/Designs', ['link', 'f.html'], escape), 'darwin symlink out');
    // The lexical refusals do not depend on case.
    await rejectsBadPath(resolveInside('/Users/you/Designs', ['..', 'DESIGNS-evil'], deps), 'darwin dot-dot');
  });

  test('the same case-flipped realpath escapes on linux', async () => {
    const deps = posixDeps({ '/home/you/Designs': '/home/you/Designs', '/home/you/Designs/link': '/home/you/designs/real' });
    await rejectsBadPath(resolveInside('/home/you/Designs', ['link', 'f.html'], deps), 'linux case-sensitive escape');
  });
});

describe('writeFileAtomic', () => {
  test('writes the file, creates parents, leaves no tmp behind', async (t) => {
    const tmp = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), 'dc-atomic-')));
    t.after(() => rm(tmp, { recursive: true, force: true, maxRetries: 3 }));
    const target = path.join(tmp, 'nested', 'design.json');
    await writeFileAtomic(target, '{"version":1}\n');
    await writeFileAtomic(target, '{"version":2}\n');
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(target, 'utf8'), '{"version":2}\n');
    const left = (await readdir(path.join(tmp, 'nested'))).filter((name) => name.includes('.tmp-'));
    assert.deepEqual(left, []);
  });
});
