// A throwaway designs root per test, under the OS temp folder, removed after the test.
// The path is realpath'd: Windows TEMP may be an 8.3 short name (C:\Users\ABCDEF~1\…), which
// would make containment comparisons against fs.realpath results fail spuriously.

import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';

export type FileContent = string | Uint8Array | object;

export type TmpRoot = {
  /** Absolute, realpath'd folder. */
  root: string;
  /** Absolute path of a `/`-separated relative path inside the root. */
  at(relative: string): string;
  /** Write a file (parents created). Objects are written as pretty JSON. Returns the absolute path. */
  write(relative: string, content: FileContent): Promise<string>;
  read(relative: string): Promise<string>;
  /** Write a design folder: `files` maps relative paths to content (`design.json` may be an object). */
  writeDesign(slug: string, files: Record<string, FileContent>): Promise<string>;
  cleanup(): Promise<void>;
};

const toBytes = (content: FileContent): string | Uint8Array =>
  typeof content === 'string' || content instanceof Uint8Array ? content : `${JSON.stringify(content, null, 2)}\n`;

export const createTmpRoot = async (prefix = 'dc-test-'): Promise<TmpRoot> => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  const at = (relative: string): string => path.join(root, ...relative.split('/'));
  const write = async (relative: string, content: FileContent): Promise<string> => {
    const target = at(relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, toBytes(content));
    return target;
  };
  return {
    root,
    at,
    write,
    read: (relative) => readFile(at(relative), 'utf8'),
    writeDesign: async (slug, files) => {
      await mkdir(at(slug), { recursive: true });
      for (const [relative, content] of Object.entries(files)) await write(`${slug}/${relative}`, content);
      return at(slug);
    },
    cleanup: () => rm(root, { recursive: true, force: true, maxRetries: 3 }),
  };
};

/** `createTmpRoot` removed automatically when the test ends. */
export const useTmpRoot = async (t: TestContext, prefix?: string): Promise<TmpRoot> => {
  const tmp = await createTmpRoot(prefix);
  t.after(() => tmp.cleanup());
  return tmp;
};
