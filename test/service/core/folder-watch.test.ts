// folder-watch.ts: the per-folder recursive watch the designs root uses on Linux. Runs on every
// OS (plain fs.watch on a folder works everywhere). The case that broke Node's recursive mode
// on Linux: design.json replaced by rename, then written in place — the in-place write must
// still be seen.

import assert from 'node:assert/strict';
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';

import { watchFolders } from '../../../src/service/folder-watch.ts';
import { useTmpRoot } from '../../helpers/tmp-root.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (seen: string[], predicate: (name: string) => boolean, label: string, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!seen.some(predicate)) {
    if (Date.now() > deadline) throw new Error(`no event for ${label}; saw ${JSON.stringify(seen)}`);
    await sleep(20);
  }
};

describe('watchFolders', () => {
  test('sees writes in existing and new design folders, including a file written in place after a rename-over', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('old/index.html', '<h1>old</h1>');
    const seen: string[] = [];
    const watcher = watchFolders(tmp.root, { persistent: false }, (_event, name) => void seen.push(name ?? '<null>'));
    t.after(() => watcher.close());
    await sleep(150); // existing folders are adopted asynchronously

    await writeFile(tmp.at('old/index.html'), '<h1>changed</h1>');
    await waitFor(seen, (name) => name === 'old/index.html', 'old/index.html');

    await mkdir(tmp.at('neu/screens'), { recursive: true });
    await writeFile(tmp.at('neu/screens/home.html'), '<h1>home</h1>');
    await waitFor(seen, (name) => name === 'neu/screens/home.html', 'a file in a folder that just appeared');

    await writeFile(tmp.at('neu/.design.json.tmp'), '{"v":1}');
    await rename(tmp.at('neu/.design.json.tmp'), tmp.at('neu/design.json'));
    await writeFile(tmp.at('neu/.design.json.tmp'), '{"v":2}');
    await rename(tmp.at('neu/.design.json.tmp'), tmp.at('neu/design.json')); // replaced by rename
    await sleep(150);
    const mark = seen.length;
    await writeFile(tmp.at('neu/design.json'), '{"v":3}'); // the agent writes in place
    await waitFor(seen.slice(mark), (name) => name === 'neu/design.json', 'an in-place write after a rename-over');

    await rm(tmp.at('neu'), { recursive: true, force: true });
    await waitFor(seen, (name) => name === 'neu', 'the removed folder');
  });

  test('dot folders and top-level folders that are not designs are not descended into', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('art/.chamber/state.json', '{}');
    await tmp.write('Not A Slug/notes.txt', 'mine');
    const seen: string[] = [];
    const watched: string[] = [];
    const spy = ((target: string, options: object, listener: (event: string, name: string | null) => void) => {
      watched.push(target);
      return fsWatch(target, options, listener);
    }) as unknown as typeof fsWatch;
    const watcher = watchFolders(tmp.root, { persistent: false }, (_event, name) => void seen.push(name ?? ''), spy);
    t.after(() => watcher.close());
    await sleep(150);
    assert.deepEqual(watched.map((target) => target.slice(tmp.root.length).replace(/\\/g, '/')).sort(), ['', '/art']);
    await writeFile(tmp.at('art/.chamber/state.json'), '{"x":1}');
    await writeFile(tmp.at('Not A Slug/notes.txt'), 'changed');
    await sleep(300);
    assert.ok(!seen.includes('art/.chamber/state.json'), 'nothing inside .chamber/ is reported');
    assert.ok(!seen.includes('Not A Slug/notes.txt'), 'nothing inside the user\'s own folder is reported');
  });

  test('a sub-folder watch that hits the inotify limit fails the whole watch (watch.ts then polls); a missing root throws', async (t) => {
    const tmp = await useTmpRoot(t);
    await mkdir(tmp.at('art'), { recursive: true });
    const limited = ((target: string, options: object, listener: (event: string, name: string | null) => void) => {
      if (target !== tmp.root) throw Object.assign(new Error('ENOSPC: System limit for number of file watchers reached'), { code: 'ENOSPC' });
      return fsWatch(target, options, listener);
    }) as unknown as typeof fsWatch;
    const errors: string[] = [];
    const watcher: FSWatcher = watchFolders(tmp.root, { persistent: false }, () => undefined, limited);
    watcher.on('error', (error: NodeJS.ErrnoException) => void errors.push(error.code ?? ''));
    t.after(() => watcher.close());
    await sleep(150);
    assert.deepEqual(errors, ['ENOSPC']);

    assert.throws(() => watchFolders(tmp.at('missing'), { persistent: false }, () => undefined), (error: NodeJS.ErrnoException) => error.code === 'ENOENT');
  });

  test('close stops every folder watch', async (t) => {
    const tmp = await useTmpRoot(t);
    await tmp.write('art/index.html', 'x');
    const seen: string[] = [];
    const watcher = watchFolders(tmp.root, { persistent: false }, (_event, name) => void seen.push(name ?? ''));
    await sleep(150);
    watcher.close();
    const mark = seen.length; // Windows may still deliver the folder's own creation before this
    await writeFile(tmp.at('art/index.html'), 'y');
    await mkdir(tmp.at('later'), { recursive: true });
    await sleep(300);
    assert.deepEqual(seen.slice(mark), []);
  });
});
