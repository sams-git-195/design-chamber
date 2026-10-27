// Golden-file assertions for the sample outputs under `__snapshots__/` (the chip, RULES.md and a
// revision prompt as the agent receives them, kept for review). Regenerate after an intended
// wording change with `UPDATE_SNAPSHOTS=1 npm test`, then read the diff.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DIR = path.join(import.meta.dirname, '__snapshots__');
const lf = (text: string): string => text.replace(/\r\n/g, '\n');

export const assertSnapshot = async (name: string, actual: string): Promise<void> => {
  const file = path.join(DIR, name);
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    await mkdir(DIR, { recursive: true });
    await writeFile(file, `${lf(actual).replace(/\n*$/, '')}\n`);
    return;
  }
  const expected = await readFile(file, 'utf8').catch(() => null);
  assert.notEqual(expected, null, `Missing snapshot ${name}: run UPDATE_SNAPSHOTS=1 npm test and review the file.`);
  assert.equal(`${lf(actual).replace(/\n*$/, '')}\n`, lf(expected ?? ''), `Snapshot ${name} differs: if the change is intended, run UPDATE_SNAPSHOTS=1 npm test and review the diff.`);
};
